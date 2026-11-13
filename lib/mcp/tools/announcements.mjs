/**
 * lib/mcp/tools/announcements.mjs
 *
 * Announcement tools, behind the zander.web.announcements node. An announcement
 * is a "post" that publishes to one or more platforms (web banner, site popup,
 * in-game tip, server-list MOTD, hologram). These call the post service
 * (services/announcementPostService.js) in-process; the acting staff member is
 * recorded as createdBy for the audit log.
 */

import { ToolError } from "../protocol.mjs";
import { compact, parseDateTime } from "./helpers.mjs";
import { generateLog } from "../../../api/common.js";
import {
  createPost,
  updatePost,
  deletePost,
  getPost,
  listPosts,
} from "../../../services/announcementPostService.js";

const NODE = ["zander.web.announcements"];
const PLATFORMS = ["web", "popup", "tip", "motd", "hologram"];
const COLOUR_PLATFORMS = new Set(["tip", "motd", "hologram"]);

/** ISO (or "") for a date-ish input; throws ToolError on a bad value. */
function dateField(value, name) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  try {
    return parseDateTime(value, name).toISOString();
  } catch (e) {
    throw new ToolError(`${name}: ${e?.message || "invalid date"}`);
  }
}

const PLATFORM_FIELDS = {
  platform: { type: "string", enum: PLATFORMS, description: "web = site banner, popup = site popup, tip = in-game tip, motd = server-list MOTD, hologram = in-game hologram frame." },
  enabled: { type: "boolean", description: "Whether this platform is shown. On update, left out = keep its current state." },
  body: { type: "string", description: "Plain message text (web/popup). Ignored for colour platforms." },
  colourMessageFormat: { type: "string", description: "tip/motd/hologram: message with Minecraft colour codes, e.g. '&6Double XP!'." },
  link: { type: "string", description: "web/popup/tip/hologram: link starting with /, https://, http:// or mailto:." },
  popupButtonText: { type: "string", description: "popup only: button label (60 chars max)." },
  popupImageUrl: { type: "string", description: "popup only: image URL." },
  hologramGroup: { type: "string", description: "hologram only: group slug (frames in a group rotate)." },
  sortOrder: { type: "integer", description: "hologram only: lower shows first in its group." },
  countdownTo: { type: "string", description: "hologram only: ISO 8601 countdown target, or '' for none." },
  countdownFinishedText: { type: "string", description: "hologram only: text shown once the countdown passes." },
  startDate: { type: "string", description: "Optional: show from this time (ISO 8601 with an offset)." },
  endDate: { type: "string", description: "Optional: stop showing after this time (ISO 8601 with an offset)." },
};

/** Map a flat args object (single-platform) or a platforms[] entry to a row. */
function buildPlatform(src) {
  const platform = src.platform || src.announcementType;
  if (!PLATFORMS.includes(platform)) throw new ToolError(`Unknown platform "${platform}".`);
  const row = { platform };
  if (typeof src.enabled === "boolean") row.enabled = src.enabled;
  for (const key of ["body", "colourMessageFormat", "link", "popupButtonText", "popupImageUrl", "hologramGroup", "countdownFinishedText"]) {
    if (src[key] !== undefined) row[key] = src[key];
  }
  if (src.sortOrder !== undefined) row.sortOrder = src.sortOrder;
  if (src.countdownTo !== undefined) row.countdownTo = dateField(src.countdownTo, "countdownTo");
  if (src.startDate !== undefined) row.startDate = dateField(src.startDate, "startDate");
  if (src.endDate !== undefined) row.endDate = dateField(src.endDate, "endDate");
  return row;
}

/**
 * For announcements_update: fill fields the caller left out from the platform's
 * existing row, so an omitted `enabled` or end date does not silently re-enable a
 * draft/expired post or clear its schedule. "" still clears a field.
 */
export function mergeWithExisting(row, existing) {
  if (!existing) return row;
  const merged = { ...row };
  const keep = (key, value) => {
    if (merged[key] === undefined && value !== undefined && value !== null) merged[key] = value;
  };
  keep("enabled", Boolean(existing.enabled));
  // body and colourMessageFormat are alternatives for the same text, so new
  // text in either one replaces the old message rather than merging with it.
  if (row.body === undefined && row.colourMessageFormat === undefined) {
    keep("body", existing.body);
    keep("colourMessageFormat", existing.colourMessageFormat);
  }
  for (const key of ["link", "popupButtonText", "popupImageUrl", "hologramGroup", "countdownFinishedText", "sortOrder"]) {
    keep(key, existing[key]);
  }
  for (const key of ["countdownTo", "startDate", "endDate"]) {
    keep(key, existing[key] ? new Date(existing[key]).toISOString() : undefined);
  }
  return merged;
}

function platformView(r) {
  return compact({
    announcementId: r.announcementId,
    platform: r.announcementType,
    enabled: Boolean(r.enabled),
    body: r.body || undefined,
    colourMessageFormat: r.colourMessageFormat || undefined,
    link: r.link || undefined,
    popupButtonText: r.popupButtonText || undefined,
    popupImageUrl: r.popupImageUrl || undefined,
    hologramGroup: r.hologramGroup || undefined,
    sortOrder: r.announcementType === "hologram" ? r.sortOrder : undefined,
    countdownTo: r.countdownTo ? new Date(r.countdownTo).toISOString() : undefined,
    countdownFinishedText: r.countdownFinishedText || undefined,
    startDate: r.startDate ? new Date(r.startDate).toISOString() : undefined,
    endDate: r.endDate ? new Date(r.endDate).toISOString() : undefined,
  });
}

function postView(post) {
  return compact({
    postId: post.postId,
    title: post.title || undefined,
    status: post.status,
    createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : undefined,
    platforms: (post.platforms || []).map(platformView),
  });
}

function asValidationError(error) {
  if (error?.errors) return new ToolError(error.errors.join(" "));
  return error;
}

export const announcementTools = [
  {
    name: "announcements_list",
    title: "List announcements",
    feature: "announcements",
    permission: NODE,
    description: "List announcement posts and their platform rows. Optional filters: platform, status (active/scheduled/ended/disabled), hologram group.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: PLATFORMS },
        status: { type: "string", enum: ["active", "scheduled", "ended", "disabled"] },
        group: { type: "string", description: "Hologram group slug (use with platform=hologram)." },
      },
    },
    annotations: { readOnlyHint: true },
    async handler({ platform, status, group }, ctx) {
      const posts = await listPosts({ platform, status, group });
      return posts.map(postView);
    },
  },
  {
    name: "announcements_create",
    title: "Create announcement",
    feature: "announcements",
    permission: NODE,
    description:
      "Create an announcement post that publishes to one or more platforms. Pass `platforms` (an array, each with a `platform` and its fields) " +
      "to publish to several at once, or a single `announcementType` plus its fields for a one-platform post. It goes live straight away unless " +
      "disabled or given a future startDate, so confirm the wording first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Optional post title; defaults to the start of the message." },
        enabled: { type: "boolean", description: "Whether the post is shown (default true). false = save as a draft." },
        platforms: {
          type: "array",
          description: "One entry per platform to publish to.",
          items: { type: "object", properties: PLATFORM_FIELDS, required: ["platform"] },
        },
        // Single-platform backward-compatible fields:
        announcementType: { type: "string", enum: PLATFORMS, description: "Single-platform shortcut: the one platform to publish to." },
        body: PLATFORM_FIELDS.body,
        colourMessageFormat: PLATFORM_FIELDS.colourMessageFormat,
        link: PLATFORM_FIELDS.link,
        popupButtonText: PLATFORM_FIELDS.popupButtonText,
        popupImageUrl: PLATFORM_FIELDS.popupImageUrl,
        hologramGroup: PLATFORM_FIELDS.hologramGroup,
        sortOrder: PLATFORM_FIELDS.sortOrder,
        countdownTo: PLATFORM_FIELDS.countdownTo,
        countdownFinishedText: PLATFORM_FIELDS.countdownFinishedText,
        startDate: PLATFORM_FIELDS.startDate,
        endDate: PLATFORM_FIELDS.endDate,
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args, ctx) {
      let platforms;
      if (Array.isArray(args.platforms) && args.platforms.length) {
        platforms = args.platforms.map(buildPlatform);
      } else if (args.announcementType) {
        platforms = [buildPlatform(args)];
      } else {
        throw new ToolError("Provide either `platforms` or a single `announcementType`.");
      }
      try {
        const postId = await createPost({
          title: args.title || null,
          shared: { enabled: args.enabled !== false },
          platforms,
          createdBy: ctx.user.userId,
        });
        await generateLog(ctx.user.userId, "SUCCESS", "ANNOUNCEMENT", `Created post ${postId} (MCP)`).catch(() => {});
        const post = await getPost(postId);
        return { message: "Announcement created.", post: postView(post) };
      } catch (error) {
        throw asValidationError(error);
      }
    },
  },
  {
    name: "announcements_update",
    title: "Update announcement",
    feature: "announcements",
    permission: NODE,
    description:
      "Replace an announcement post's platforms. Pass the full desired `platforms` set (platforms left out are removed). " +
      "Fields left out of a platform that already exists keep their current values (pass \"\" to clear one), including its enabled state and dates. " +
      "To just hide a post, set enabled=false (whole post) or enabled=false on every platform.",
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "integer", minimum: 1 },
        title: { type: "string" },
        enabled: { type: "boolean", description: "Apply to the whole post (draft toggle). Left out = each platform keeps its current state." },
        platforms: {
          type: "array",
          items: { type: "object", properties: PLATFORM_FIELDS, required: ["platform"] },
        },
      },
      required: ["postId", "platforms"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args, ctx) {
      const existing = await getPost(args.postId);
      if (!existing) throw new ToolError(`Post ${args.postId} not found.`);
      const existingByType = new Map((existing.platforms || []).map((r) => [r.announcementType, r]));
      const platforms = (args.platforms || []).map((p) => {
        const row = buildPlatform(p);
        // A post-level enabled applies to every platform; otherwise keep each row's own.
        if (typeof args.enabled === "boolean" && row.enabled === undefined) row.enabled = args.enabled;
        return mergeWithExisting(row, existingByType.get(row.platform));
      });
      try {
        await updatePost(args.postId, {
          title: args.title !== undefined ? args.title : existing.title,
          shared: typeof args.enabled === "boolean" ? { enabled: args.enabled } : {},
          platforms,
          updatedBy: ctx.user.userId,
        });
        await generateLog(ctx.user.userId, "SUCCESS", "ANNOUNCEMENT", `Edited post ${args.postId} (MCP)`).catch(() => {});
        const post = await getPost(args.postId);
        return { message: "Announcement updated.", post: postView(post) };
      } catch (error) {
        throw asValidationError(error);
      }
    },
  },
  {
    name: "announcements_delete",
    title: "Delete announcement",
    feature: "announcements",
    permission: NODE,
    description: "Permanently delete an announcement post and all its platform rows. To hide it instead, update it with every platform disabled.",
    inputSchema: {
      type: "object",
      properties: { postId: { type: "integer", minimum: 1 } },
      required: ["postId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async handler({ postId }, ctx) {
      const existing = await getPost(postId);
      if (!existing) throw new ToolError(`Post ${postId} not found.`);
      await deletePost(postId);
      await generateLog(ctx.user.userId, "WARNING", "ANNOUNCEMENT", `Deleted post ${postId} (MCP)`).catch(() => {});
      return { message: "Announcement deleted." };
    },
  },
];
