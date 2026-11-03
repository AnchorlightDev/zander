/**
 * lib/mcp/tools/moderation.mjs
 *
 * Moderation and support tools: punishment and report lookups, and reading and
 * replying to support tickets. Ticket access follows the website's rules
 * (routes/support.js, routes/dashboard/support.js): staff see a category's
 * tickets with zander.web.tickets plus that category's node, and anyone can
 * see tickets they opened or were added to.
 */

import db from "../../../controllers/databaseController.js";
import { client as discordClient } from "../../../controllers/discordController.js";
import { getUserPunishments } from "../../../services/profileService.js";
import { getDiscordPunishmentsForProfile } from "../../../controllers/discordPunishmentController.js";
import {
  createSupportTicketMessage,
  getAllTickets,
  getSupportCategories,
  getTicketById,
  getTicketMessages,
  getTicketParticipants,
  syncParticipantsForMessage,
} from "../../../controllers/supportTicketController.js";
import { ToolError } from "../protocol.mjs";
import { compact, holdsAny, requireAny, siteUrl } from "./helpers.mjs";

const PUNISHMENT_VIEW = ["zander.web.punishments", "zander.web.punishment.view"];
const REPORT_VIEW = ["zander.web.reports"];
const TICKETS = ["zander.web.tickets"];

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

// ── Tickets ────────────────────────────────────────────────────────────────

/** Same slug rule as routes/dashboard/support.js getCategorySlug. */
export function categorySlug(category) {
  if (!category) return "";
  if (category.slug) return category.slug;
  const source = category.name || `category-${category.categoryId}`;
  return String(source)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function canSeeCategory(user, category) {
  if (!holdsAny(user, TICKETS)) return false;
  const slug = categorySlug(category);
  return Boolean(slug) && holdsAny(user, [`zander.web.tickets.${slug}`, "zander.web.tickets.*"]);
}

/** Owner, participant, or staff with category access -- the website's rule. */
async function ticketAccess(user, ticket, category) {
  const participants = await getTicketParticipants(ticket.ticketId);
  const rankSlugs = (user.ranks || []).map((r) => r.rankSlug);
  const isOwner = Number(ticket.userId) === Number(user.userId);
  const isParticipant =
    participants.users.some((p) => Number(p.userId) === Number(user.userId)) ||
    rankSlugs.some((slug) => participants.groups.some((g) => g.rankSlug === slug));
  const staffAccess = Boolean(user.isStaff) && canSeeCategory(user, category);
  return { allowed: isOwner || isParticipant || staffAccess, isOwner, rankSlugs };
}

async function loadTicket(user, ticketId) {
  const ticket = await getTicketById(ticketId);
  if (!ticket) throw new ToolError(`Ticket #${ticketId} not found.`);
  const categories = await getSupportCategories();
  const category = categories.find((c) => Number(c.categoryId) === Number(ticket.categoryId));
  const access = await ticketAccess(user, ticket, category);
  if (!access.allowed) throw new ToolError(`You don't have access to ticket #${ticketId}.`);
  return { ticket, category, access };
}

function ticketView(ticket, category) {
  return compact({
    ticketId: ticket.ticketId,
    title: ticket.title,
    status: ticket.status,
    category: category?.name,
    openedBy: ticket.username || undefined,
    escalated: ticket.isEscalated ? true : undefined,
    locked: ticket.isLocked ? true : undefined,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    url: siteUrl(`/support/ticket/${ticket.ticketId}`),
  });
}

// ── Tools ─────────────────────────────────────────────────────────────────

export const moderationTools = [
  {
    name: "punishments_lookup",
    title: "Look up a player's punishments",
    permission: PUNISHMENT_VIEW,
    description:
      "A player's in-game punishments (bans, mutes, kicks, warnings from LiteBans) and Discord/web punishments, newest first.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string", description: "Site/Minecraft username." } },
      required: ["username"],
    },
    annotations: { readOnlyHint: true },
    async handler({ username }) {
      const result = await getUserPunishments(username);
      if (!result?.success) throw new ToolError(result?.message || `Couldn't find ${username}.`);

      const game = (result.data || []).map((p) =>
        compact({
          type: p.type,
          active: p.active === null ? undefined : Boolean(Number(p.active)),
          reason: p.reason,
          by: p.bannedByUsername || undefined,
          start: p.dateStart,
          end: p.dateEnd || undefined,
          removedBy: p.removedByUsername || undefined,
          removedReason: p.reasonRemoved || undefined,
        })
      );

      let discord = [];
      try {
        const rows = await getDiscordPunishmentsForProfile({ playerId: result.target?.userId });
        discord = rows.map((p) =>
          compact({
            type: p.type,
            platform: p.platform,
            status: p.status,
            reason: p.reason,
            by: p.actor_name_snapshot || undefined,
            created: p.created_at,
            expires: p.expires_at || undefined,
          })
        );
      } catch {
        // Discord punishments are optional context; the game record still answers.
      }

      return { player: result.target?.username, gamePunishments: game, discordAndWebPunishments: discord };
    },
  },
  {
    name: "reports_list",
    title: "List player reports",
    feature: "report",
    permission: REPORT_VIEW,
    description: "Player reports, newest first. Filter by the reported player's username.",
    inputSchema: {
      type: "object",
      properties: {
        reportedUser: { type: "string", description: "Only reports about this username." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
      },
    },
    annotations: { readOnlyHint: true },
    async handler({ reportedUser, limit }) {
      const params = [];
      let where = "";
      if (reportedUser) {
        where = "WHERE r.reportedUser = ?";
        params.push(reportedUser);
      }
      params.push(limit || 25);
      const rows = await query(
        `SELECT r.reportId, r.reportedUser, r.reportReason, r.reportReasonEvidence, r.reportPlatform,
                r.reportDateTime, u.username AS reporter
           FROM reports r LEFT JOIN users u ON u.userId = r.reporterId
           ${where}
          ORDER BY r.reportDateTime DESC
          LIMIT ?`,
        params
      );
      return rows.map((r) =>
        compact({
          reportId: r.reportId,
          reportedUser: r.reportedUser,
          reason: r.reportReason,
          evidence: r.reportReasonEvidence || undefined,
          platform: r.reportPlatform,
          reporter: r.reporter || undefined,
          at: r.reportDateTime,
        })
      );
    },
  },
  {
    name: "tickets_list",
    title: "List support tickets",
    feature: "support",
    permission: TICKETS,
    description: "Support tickets in the categories you can see, newest first. Filter by status, category or text.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "in-progress", "closed"], description: "Default: open and in-progress." },
        category: { type: "string", description: "Category name (e.g. 'Player Report')." },
        search: { type: "string", description: "Text to match in the ticket title or opener's name." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
      },
    },
    annotations: { readOnlyHint: true },
    async handler({ status, category, search, limit }, ctx) {
      requireAny(ctx.user, TICKETS, "view support tickets");
      const categories = await getSupportCategories();
      const visible = new Map(
        categories.filter((c) => canSeeCategory(ctx.user, c)).map((c) => [Number(c.categoryId), c])
      );
      if (!visible.size) throw new ToolError("You don't have access to any ticket categories.");

      const wantCategory = category ? String(category).toLowerCase() : null;
      const needle = search ? String(search).toLowerCase() : null;

      const tickets = (await getAllTickets())
        .filter((t) => visible.has(Number(t.categoryId)))
        .filter((t) => (status ? t.status === status : t.status !== "closed"))
        .filter((t) => !wantCategory || visible.get(Number(t.categoryId))?.name?.toLowerCase() === wantCategory)
        .filter(
          (t) =>
            !needle ||
            String(t.title || "").toLowerCase().includes(needle) ||
            String(t.username || "").toLowerCase().includes(needle)
        )
        .sort((a, b) => b.ticketId - a.ticketId)
        .slice(0, limit || 25);

      return tickets.map((t) => ticketView(t, visible.get(Number(t.categoryId))));
    },
  },
  {
    name: "tickets_get",
    title: "Read support ticket",
    feature: "support",
    permission: TICKETS,
    description: "A support ticket and its conversation. Staff also see internal notes (marked internal: true).",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "integer", minimum: 1 },
        lastMessages: { type: "integer", minimum: 1, maximum: 200, description: "How many recent messages (default 50)." },
      },
      required: ["ticketId"],
    },
    annotations: { readOnlyHint: true },
    async handler({ ticketId, lastMessages }, ctx) {
      const { ticket, category } = await loadTicket(ctx.user, ticketId);
      const owner = ticket.userId
        ? (await query("SELECT username FROM users WHERE userId = ? LIMIT 1", [ticket.userId]))[0]?.username
        : `${ticket.guestName || "Guest"} (guest)`;
      const messages = await getTicketMessages(ticketId, Boolean(ctx.user.isStaff));
      return {
        ticket: { ...ticketView({ ...ticket, username: owner }, category) },
        messages: messages.slice(-(lastMessages || 50)).map((m) =>
          compact({
            from: m.username || (m.userId ? `user ${m.userId}` : "Guest"),
            at: m.createdAt,
            internal: m.isInternal ? true : undefined,
            type: m.messageType && m.messageType !== "message" ? m.messageType : undefined,
            message: m.message,
          })
        ),
      };
    },
  },
  {
    name: "tickets_reply",
    title: "Reply to support ticket",
    feature: "support",
    permission: TICKETS,
    description:
      "Post a reply on a support ticket as you (it is mirrored to the ticket's Discord channel and the opener is " +
      "notified). Set internal=true for a staff-only note. Show the user the exact reply and confirm before sending.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "integer", minimum: 1 },
        message: { type: "string", maxLength: 4000 },
        internal: { type: "boolean", description: "Staff-only internal note instead of a public reply." },
      },
      required: ["ticketId", "message"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler({ ticketId, message, internal }, ctx) {
      const { ticket, access } = await loadTicket(ctx.user, ticketId);
      const text = String(message).trim();
      if (!text) throw new ToolError("The reply is empty.");
      if (ticket.status === "closed") throw new ToolError(`Ticket #${ticketId} is closed. Reopen it on the website first.`);
      if (ticket.isLocked && !ctx.user.isStaff) throw new ToolError(`Ticket #${ticketId} is locked.`);
      if (ticket.isEscalated && !access.isOwner && !holdsAny(ctx.user, ["zander.web.ticket.escalate"])) {
        throw new ToolError("This ticket is escalated. Only the opener and escalation staff may reply.");
      }
      if (!ctx.user.uuid) {
        throw new ToolError("Your Minecraft account isn't linked to your site account, which ticket replies require.");
      }
      if (internal && !ctx.user.isStaff) throw new ToolError("Only staff can add internal notes.");

      const messageId = await createSupportTicketMessage(discordClient, ticketId, ctx.user.userId, text, "web", {
        isInternal: Boolean(internal),
      });
      await syncParticipantsForMessage(discordClient, ticket.ticketId, {
        userId: ctx.user.userId,
        rankSlugs: access.rankSlugs,
      });

      return {
        message: internal ? "Internal note added." : "Reply posted.",
        messageId,
        url: siteUrl(`/support/ticket/${ticketId}`),
      };
    },
  },
];
