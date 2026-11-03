/**
 * lib/mcp/tools/ranks.mjs
 *
 * Rank tools. They follow the dashboard's rank manager exactly: check
 * zander.web.rank, then call /api/rank/* with this app's own API credential
 * and the actor fields the dashboard proxy adds (api/internal_redirect/rank.js),
 * so LuckPerms is written the same way and Discord roles resync the same way.
 *
 * One extra guard for Claude: it may not assign or remove a rank that sits
 * above the highest rank the signed-in staff member holds.
 */

import { ToolError } from "../protocol.mjs";
import { api, compact, holdsAny, parseDateTime, requireAny } from "./helpers.mjs";

const MANAGE = ["zander.web.rank"];
const VIEW = ["zander.web.rank", "zander.web.ranks"];

const SLUG = /^[A-Za-z0-9_.-]{1,36}$/; // same rule as api/routes/ranks.js

function rankView(r) {
  return compact({
    rankSlug: r.rankSlug,
    displayName: r.displayName,
    priority: r.priority,
    isStaff: r.isStaff ? true : undefined,
    isDonator: r.isDonator ? true : undefined,
    title: r.title || undefined,
    expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : undefined,
  });
}

async function directory(ctx) {
  const result = await api(ctx, { method: "GET", url: "/api/rank/get", internal: true });
  return result.data || [];
}

async function userRanks(ctx, username) {
  const result = await api(ctx, {
    method: "GET",
    url: `/api/rank/user?username=${encodeURIComponent(username)}`,
    internal: true,
  });
  return result.data;
}

/** Refuse ranks weighted above the actor's own highest rank. */
async function assertWithinActorReach(ctx, rankSlug) {
  if (holdsAny(ctx.user, ["*"])) return;
  const ranks = await directory(ctx);
  const target = ranks.find((r) => r.rankSlug === rankSlug);
  if (!target) throw new ToolError(`There is no rank called "${rankSlug}". Use ranks_list to see them.`);

  const own = await userRanks(ctx, ctx.user.username).catch(() => null);
  const ownTop = Math.max(...(own?.ranks || []).map((r) => r.priority ?? 0), 0);
  if ((target.priority ?? 0) > ownTop) {
    throw new ToolError(
      `${target.displayName} ranks above your own highest rank, so it can't be changed through Claude. Use the dashboard if this is intended.`
    );
  }
}

function checkSlug(rankSlug) {
  if (!SLUG.test(rankSlug)) throw new ToolError(`"${rankSlug}" isn't a valid rank slug.`);
}

export const rankTools = [
  {
    name: "ranks_list",
    title: "List ranks",
    feature: "ranks",
    permission: VIEW,
    description: "List every rank (LuckPerms group) with its display name and priority, highest first.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async handler(_args, ctx) {
      return (await directory(ctx)).map(rankView);
    },
  },
  {
    name: "ranks_list_members",
    title: "List rank members",
    feature: "ranks",
    permission: VIEW,
    description: "List the players who directly hold a rank.",
    inputSchema: {
      type: "object",
      properties: { rankSlug: { type: "string", description: "Rank slug, e.g. 'moderator'." } },
      required: ["rankSlug"],
    },
    annotations: { readOnlyHint: true },
    async handler({ rankSlug }, ctx) {
      checkSlug(rankSlug);
      const result = await api(ctx, {
        method: "GET",
        url: `/api/rank/get?rank=${encodeURIComponent(rankSlug)}`,
        internal: true,
      });
      return (result.data || []).map((m) => compact({ username: m.username, userId: m.userId, title: m.title || undefined }));
    },
  },
  {
    name: "ranks_get_user",
    title: "Get a player's ranks",
    feature: "ranks",
    permission: VIEW,
    description: "Look up a player by Minecraft/site username and list the ranks they hold, with titles and expiry.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string", description: "Minecraft or site username." } },
      required: ["username"],
    },
    annotations: { readOnlyHint: true },
    async handler({ username }, ctx) {
      const data = await userRanks(ctx, username);
      return {
        user: compact({ username: data.user?.username, userId: data.user?.userId, uuid: data.user?.uuid }),
        ranks: (data.ranks || []).map(rankView),
      };
    },
  },
  {
    name: "ranks_assign",
    title: "Assign rank",
    feature: "ranks",
    permission: MANAGE,
    description:
      "Give a player a rank (LuckPerms group), optionally with a title or an expiry for a temporary rank. " +
      "Their Discord roles are resynced. Confirm the player and rank with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Minecraft or site username." },
        rankSlug: { type: "string", description: "Rank slug from ranks_list." },
        title: { type: "string", maxLength: 64, description: "Optional title shown with the rank." },
        expiresAt: {
          type: "string",
          description: "Optional expiry for a temporary rank, ISO 8601 with an offset.",
        },
      },
      required: ["username", "rankSlug"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async handler({ username, rankSlug, title, expiresAt }, ctx) {
      requireAny(ctx.user, MANAGE, "manage ranks");
      checkSlug(rankSlug);
      if (expiresAt !== undefined && parseDateTime(expiresAt, "expiresAt") <= new Date()) {
        throw new ToolError("expiresAt must be in the future.");
      }
      await assertWithinActorReach(ctx, rankSlug);

      const result = await api(ctx, {
        method: "POST",
        url: "/api/rank/user/assign",
        internal: true,
        body: compact({
          username,
          rankSlug,
          title,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          actor: ctx.user.username,
          actorUserId: ctx.user.userId,
          actorUuid: ctx.user.uuid,
        }),
      });
      return { message: result.message, discordSync: result.discordSync };
    },
  },
  {
    name: "ranks_remove",
    title: "Remove rank",
    feature: "ranks",
    permission: MANAGE,
    description:
      "Take a rank off a player. Their Discord roles are resynced. Confirm with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Minecraft or site username." },
        rankSlug: { type: "string", description: "Rank slug from ranks_get_user." },
      },
      required: ["username", "rankSlug"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async handler({ username, rankSlug }, ctx) {
      requireAny(ctx.user, MANAGE, "manage ranks");
      checkSlug(rankSlug);
      await assertWithinActorReach(ctx, rankSlug);

      const result = await api(ctx, {
        method: "POST",
        url: "/api/rank/user/remove",
        internal: true,
        body: { username, rankSlug, actor: ctx.user.username },
      });
      return { message: result.message, discordSync: result.discordSync };
    },
  },
];
