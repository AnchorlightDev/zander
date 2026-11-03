/**
 * lib/mcp/tools/announcements.mjs
 *
 * Announcement tools: the same /api/announcement/* calls the dashboard's
 * announcement proxy makes (api/internal_redirect/announcement.js), behind the
 * same zander.web.announcements node, with the staff member as actioningUser
 * so the audit log shows who did it.
 */

import { ToolError } from "../protocol.mjs";
import { api, compact, parseDateTime } from "./helpers.mjs";

const NODE = ["zander.web.announcements"];
const TYPES = ["web", "popup", "tip", "motd"];

const FIELDS = {
  announcementType: {
    type: "string",
    enum: TYPES,
    description: "web = site banner, popup = site popup, tip = in-game tip, motd = server-list MOTD.",
  },
  body: { type: "string", description: "The message text (banner body, popup message, tip or MOTD text)." },
  colourMessageFormat: {
    type: "string",
    description: "tip and motd only: the message with Minecraft colour codes, e.g. '&6Double XP &fthis weekend!'.",
  },
  link: { type: "string", description: "web, popup and tip only: link starting with /, https://, http:// or mailto:." },
  popupButtonText: { type: "string", description: "popup only: button label." },
  popupImageUrl: { type: "string", description: "popup only: image URL." },
  enabled: { type: "boolean", description: "Whether it is shown (default true)." },
  startDate: { type: "string", description: "Optional: show from this time, ISO 8601 with an offset. Must be in the future." },
  endDate: { type: "string", description: "Optional: stop showing after this time, ISO 8601 with an offset." },
};

function dateField(value, name) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  return parseDateTime(value, name).toISOString();
}

function view(a) {
  return compact({
    announcementId: a.announcementId,
    announcementType: a.announcementType,
    enabled: Boolean(Number(a.enabled)),
    body: a.body,
    colourMessageFormat: a.colourMessageFormat || undefined,
    link: a.link || undefined,
    popupButtonText: a.popupButtonText || undefined,
    startDate: a.startDate || undefined,
    endDate: a.endDate || undefined,
  });
}

async function loadAnnouncement(ctx, announcementId) {
  const result = await api(ctx, {
    method: "GET",
    url: `/api/announcement/get?announcementId=${encodeURIComponent(announcementId)}`,
    internal: true,
  });
  const row = (result.data || [])[0];
  if (!row) throw new ToolError(`Announcement ${announcementId} not found.`);
  return row;
}

export const announcementTools = [
  {
    name: "announcements_list",
    title: "List announcements",
    feature: "announcements",
    permission: NODE,
    description: "List site banners, popups, in-game tips and MOTDs. Optionally only enabled or disabled ones, or one type.",
    inputSchema: {
      type: "object",
      properties: {
        announcementType: { type: "string", enum: TYPES },
        enabled: { type: "boolean", description: "true = only currently active ones, false = only disabled ones." },
      },
    },
    annotations: { readOnlyHint: true },
    async handler({ announcementType, enabled }, ctx) {
      const query = enabled === undefined ? "" : `?enabled=${enabled ? 1 : 0}`;
      const result = await api(ctx, { method: "GET", url: `/api/announcement/get${query}`, internal: true });
      return (result.data || [])
        .filter((a) => !announcementType || a.announcementType === announcementType)
        .map(view);
    },
  },
  {
    name: "announcements_create",
    title: "Create announcement",
    feature: "announcements",
    permission: NODE,
    description:
      "Create a site banner, site popup, in-game tip or server MOTD. It goes live straight away if enabled and " +
      "no startDate is set, so confirm the wording with the user first.",
    inputSchema: { type: "object", properties: FIELDS, required: ["announcementType", "body"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args, ctx) {
      const result = await api(ctx, {
        method: "POST",
        url: "/api/announcement/create",
        internal: true,
        body: compact({
          actioningUser: ctx.user.userId,
          announcementType: args.announcementType,
          enabled: args.enabled === false ? 0 : 1,
          body: args.body,
          colourMessageFormat: args.colourMessageFormat,
          link: args.link,
          popupButtonText: args.popupButtonText,
          popupImageUrl: args.popupImageUrl,
          startDate: dateField(args.startDate, "startDate"),
          endDate: dateField(args.endDate, "endDate"),
        }),
      });
      return { message: result.content || result.message || "Announcement created." };
    },
  },
  {
    name: "announcements_update",
    title: "Update announcement",
    feature: "announcements",
    permission: NODE,
    description: "Change an announcement. Only the fields given are changed; use enabled=false to switch one off.",
    inputSchema: {
      type: "object",
      properties: { announcementId: { type: "integer", minimum: 1 }, ...FIELDS },
      required: ["announcementId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args, ctx) {
      const current = await loadAnnouncement(ctx, args.announcementId);
      const keep = (name) => (args[name] !== undefined ? args[name] : current[name] ?? undefined);
      const keepDate = (name) => {
        if (args[name] !== undefined) return dateField(args[name], name);
        if (!current[name]) return "";
        const existing = new Date(current[name]);
        // The API refuses a start date in the past; one that has already
        // passed means "showing now", which an empty start date also means.
        if (name === "startDate" && existing.getTime() <= Date.now()) return "";
        return existing.toISOString();
      };

      const result = await api(ctx, {
        method: "POST",
        url: "/api/announcement/edit",
        internal: true,
        body: compact({
          actioningUser: ctx.user.userId,
          announcementId: args.announcementId,
          announcementType: keep("announcementType"),
          enabled: args.enabled === undefined ? Number(current.enabled) : args.enabled ? 1 : 0,
          body: keep("body"),
          colourMessageFormat: keep("colourMessageFormat"),
          link: keep("link"),
          popupButtonText: keep("popupButtonText"),
          popupImageUrl: keep("popupImageUrl"),
          startDate: keepDate("startDate"),
          endDate: keepDate("endDate"),
        }),
      });
      return { message: result.content || result.message || "Announcement updated." };
    },
  },
  {
    name: "announcements_delete",
    title: "Delete announcement",
    feature: "announcements",
    permission: NODE,
    description: "Permanently delete an announcement. To hide it instead, use announcements_update with enabled=false.",
    inputSchema: {
      type: "object",
      properties: { announcementId: { type: "integer", minimum: 1 } },
      required: ["announcementId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async handler({ announcementId }, ctx) {
      await loadAnnouncement(ctx, announcementId);
      const result = await api(ctx, {
        method: "POST",
        url: "/api/announcement/delete",
        internal: true,
        body: { actioningUser: ctx.user.userId, announcementId },
      });
      return { message: result.content || result.message || "Announcement deleted." };
    },
  },
];
