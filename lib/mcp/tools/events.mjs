/**
 * lib/mcp/tools/events.mjs
 *
 * Event tools. Reads go straight to services/eventService.js; every change
 * goes through the same /api/events/* route the dashboard editor uses, called
 * as the signed-in staff member (lib/mcp/principal.mjs), so the editor /
 * reviewer rules, status transitions, audit log and Discord posts all apply.
 */

import { getEvents, getEventById } from "../../../services/eventService.js";
import { getTemplates, getDefaultAnnouncements } from "../../../services/eventTemplateService.js";
import { ToolError } from "../protocol.mjs";
import { api, compact, parseDateTime, requireAny, siteUrl } from "./helpers.mjs";

const VIEW = ["zander.web.events", "zander.web.events.edit", "zander.web.events.review"];
const EDIT = ["zander.web.events.edit", "zander.web.events.review"];
const REVIEW = ["zander.web.events.review"];

const STATUSES = ["draft", "pending_review", "approved", "published", "rejected", "cancelled", "archived"];

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Plain text → simple paragraphs; anything that already looks like HTML is kept. */
function toHtml(text) {
  if (text === undefined || text === null) return text;
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  return String(text)
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function summarise(ev) {
  return {
    eventId: ev.eventId,
    title: ev.title,
    status: ev.status,
    startAt: ev.startAt,
    endAt: ev.endAt,
    timezone: ev.timezone,
    visibility: ev.visibility,
    location: ev.locationLabel || ev.serverName || null,
    template: ev.template?.title || null,
    dashboardUrl: siteUrl(`/dashboard/events/view?eventId=${ev.eventId}`),
    ...(ev.status === "published" ? { publicUrl: siteUrl(`/events/${ev.slug}`) } : {}),
  };
}

const EVENT_FIELDS = {
  title: { type: "string", maxLength: 255, description: "Event title." },
  description: {
    type: "string",
    description: "Full description. Plain text (blank lines separate paragraphs) or simple HTML.",
  },
  teaserDescription: {
    type: "string",
    description: "Shown instead of the description to people who can't see a rank-locked event.",
  },
  startAt: {
    type: "string",
    description: "Start time, ISO 8601 with an offset, e.g. 2026-11-20T19:30:00+11:00.",
  },
  endAt: { type: "string", description: "End time, ISO 8601 with an offset." },
  timezone: {
    type: "string",
    description: "IANA time zone the event is shown in, e.g. Australia/Sydney.",
  },
  visibility: {
    type: "string",
    enum: ["public", "private", "rank"],
    description: "public, private (staff only), or rank (only the ranks in allowedRanks).",
  },
  allowedRanks: {
    type: "array",
    items: { type: "string" },
    description: "Rank slugs that can see the event when visibility is 'rank'.",
  },
  teaserPublic: {
    type: "boolean",
    description: "Rank-locked events only: show a locked teaser publicly (true) or hide it entirely (false).",
  },
  locationType: { type: "string", enum: ["discord", "minecraft", "other"], description: "Where the event happens." },
  locationLabel: { type: "string", description: "Location shown to players (for 'other', or a label for the server)." },
  locationDiscordChannelId: { type: "string", description: "Discord voice channel ID when locationType is 'discord'." },
  serverName: { type: "string", description: "Minecraft server name when locationType is 'minecraft'." },
  serverIp: { type: "string", description: "Minecraft server address when locationType is 'minecraft'." },
  tags: { type: "array", items: { type: "string" }, description: "Tags, e.g. ['pvp', 'community']." },
  bannerUrl: { type: "string", description: "Banner image URL." },
  logoUrl: { type: "string", description: "Logo image URL." },
  featured: { type: "boolean", description: "Feature the event on the site." },
};

function eventBody(args) {
  const body = compact({
    title: args.title,
    description: toHtml(args.description),
    teaserDescription: toHtml(args.teaserDescription),
    timezone: args.timezone,
    visibility: args.visibility,
    allowedRanks: args.allowedRanks,
    teaserPublic: args.teaserPublic,
    locationType: args.locationType,
    locationLabel: args.locationLabel ?? (args.locationType === "minecraft" ? args.serverName : undefined),
    locationDiscordChannelId: args.locationDiscordChannelId,
    serverName: args.serverName,
    serverIp: args.serverIp,
    tags: args.tags,
    bannerUrl: args.bannerUrl,
    logoUrl: args.logoUrl,
    featured: args.featured,
  });
  if (args.startAt !== undefined) body.startAt = parseDateTime(args.startAt, "startAt").toISOString();
  if (args.endAt !== undefined) body.endAt = parseDateTime(args.endAt, "endAt").toISOString();
  if (body.startAt && body.endAt && new Date(body.endAt) <= new Date(body.startAt)) {
    throw new ToolError("endAt must be after startAt.");
  }
  return body;
}

async function loadEvent(eventId) {
  const ev = await getEventById(eventId);
  if (!ev) throw new ToolError(`Event ${eventId} not found.`);
  return ev;
}

const eventIdArg = { eventId: { type: "integer", minimum: 1, description: "Event ID." } };

export const eventTools = [
  {
    name: "events_list",
    title: "List events",
    feature: "events",
    permission: VIEW,
    description:
      "List Zander events, soonest first. Filter by status or search text. By default only shows events that haven't ended.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: STATUSES, description: "Only events in this status." },
        search: { type: "string", description: "Text to match in the title or description." },
        includePast: { type: "boolean", description: "Include events that have already ended (default false)." },
        page: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(args) {
      const result = await getEvents({
        status: args.status || null,
        search: args.search || null,
        hidePast: !args.includePast,
        page: args.page || 1,
        limit: args.limit || 20,
      });
      return { total: result.total, page: result.page, events: result.events.map(summarise) };
    },
  },
  {
    name: "events_get",
    title: "Get event",
    feature: "events",
    permission: VIEW,
    description: "Full details of one event, including hosts, rank access, actions and scheduled announcements.",
    inputSchema: { type: "object", properties: eventIdArg, required: ["eventId"] },
    annotations: { readOnlyHint: true },
    async handler({ eventId }) {
      const ev = await loadEvent(eventId);
      return {
        ...summarise(ev),
        description: ev.description,
        teaserDescription: ev.teaserDescription,
        teaserPublic: ev.teaserPublic,
        allowedRanks: (ev.rankAccess || []).map((r) => r.rankSlug),
        locationType: ev.locationType,
        serverName: ev.serverName,
        serverIp: ev.serverIp,
        tags: ev.tags,
        featured: ev.featured,
        bannerUrl: ev.bannerUrl,
        rejectionNote: ev.rejectionNote,
        hosts: (ev.hosts || []).map((h) => ({ userId: h.userId, displayName: h.displayName, role: h.role })),
        actions: (ev.actions || []).map((a) => ({ type: a.actionType, trigger: a.trigger, enabled: a.enabled })),
        announcements: (ev.announcements || []).map((a) => ({
          label: a.label,
          platform: a.platform,
          triggerType: a.triggerType,
          offsetMinutes: a.offsetMinutes,
          status: a.status,
          scheduledFor: a.scheduledFor,
        })),
        discordSyncStatus: ev.discordSyncStatus,
        discordSyncError: ev.discordSyncError,
      };
    },
  },
  {
    name: "events_create",
    title: "Create event draft",
    feature: "events",
    permission: EDIT,
    description:
      "Create a new event as a draft (nothing is posted publicly). Gets the site's default announcements unless " +
      "useDefaultAnnouncements is false. Submit it for review with events_submit_for_review when it's ready.",
    inputSchema: {
      type: "object",
      properties: {
        ...EVENT_FIELDS,
        useDefaultAnnouncements: {
          type: "boolean",
          description: "Attach the site-wide default event announcements (default true), as the dashboard does.",
        },
      },
      required: ["title", "startAt", "endAt", "timezone"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler(args, ctx) {
      requireAny(ctx.user, EDIT, "create events");
      const body = eventBody(args);
      const created = await api(ctx, { method: "POST", url: "/api/events/create", body, user: ctx.user });
      const eventId = created.data?.eventId;

      let announcementNote = "No default announcements attached.";
      if (eventId && args.useDefaultAnnouncements !== false) {
        const defaults = await getDefaultAnnouncements();
        if (defaults.length) {
          await api(ctx, {
            method: "POST",
            url: "/api/events/announcements/update",
            body: { eventId, announcements: defaults },
            user: ctx.user,
          });
          announcementNote = `Attached ${defaults.length} default announcement(s).`;
        }
      }

      return { message: `Draft created. ${announcementNote}`, event: summarise(await loadEvent(eventId)) };
    },
  },
  {
    name: "events_update",
    title: "Update event",
    feature: "events",
    permission: EDIT,
    description:
      "Change an event's details. Only the fields given are changed. Approved and published events can only be " +
      "changed by reviewers; editing a published event also updates its Discord post and scheduled event.",
    inputSchema: {
      type: "object",
      properties: { ...eventIdArg, ...EVENT_FIELDS },
      required: ["eventId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler(args, ctx) {
      requireAny(ctx.user, EDIT, "edit events");
      const existing = await loadEvent(args.eventId);
      const body = { eventId: args.eventId, ...eventBody(args) };
      if (Object.keys(body).length === 1) throw new ToolError("Nothing to change: give at least one field.");

      const url = existing.status === "published" ? "/api/events/update-published" : "/api/events/update";
      const result = await api(ctx, { method: "POST", url, body, user: ctx.user });
      return { message: result.message, event: summarise(await loadEvent(args.eventId)) };
    },
  },
  {
    name: "events_submit_for_review",
    title: "Submit event for review",
    feature: "events",
    permission: EDIT,
    description: "Send a draft event to the reviewers. Posts a review request in the review channel.",
    inputSchema: { type: "object", properties: eventIdArg, required: ["eventId"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler({ eventId }, ctx) {
      requireAny(ctx.user, EDIT, "submit events for review");
      const result = await api(ctx, { method: "POST", url: "/api/events/submit-review", body: { eventId }, user: ctx.user });
      return { message: result.message, event: summarise(await loadEvent(eventId)) };
    },
  },
  {
    name: "events_approve",
    title: "Approve and publish event",
    feature: "events",
    permission: REVIEW,
    description:
      "Approve an event that is awaiting review. This publishes it immediately: it goes live on the website and " +
      "its Discord announcement and scheduled event are posted.",
    inputSchema: { type: "object", properties: eventIdArg, required: ["eventId"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler({ eventId }, ctx) {
      requireAny(ctx.user, REVIEW, "approve events");
      const result = await api(ctx, { method: "POST", url: "/api/events/approve", body: { eventId }, user: ctx.user });
      return { message: result.message, event: summarise(await loadEvent(eventId)) };
    },
  },
  {
    name: "events_reject",
    title: "Reject event",
    feature: "events",
    permission: REVIEW,
    description: "Send an event awaiting review back to its creator with a note.",
    inputSchema: {
      type: "object",
      properties: { ...eventIdArg, note: { type: "string", description: "What needs changing." } },
      required: ["eventId", "note"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler({ eventId, note }, ctx) {
      requireAny(ctx.user, REVIEW, "reject events");
      const result = await api(ctx, {
        method: "POST",
        url: "/api/events/reject",
        body: { eventId, rejectionNote: note },
        user: ctx.user,
      });
      return { message: result.message, event: summarise(await loadEvent(eventId)) };
    },
  },
  {
    name: "events_publish",
    title: "Publish approved event",
    feature: "events",
    permission: REVIEW,
    description: "Publish an event that is already approved (puts it live on the website and Discord).",
    inputSchema: { type: "object", properties: eventIdArg, required: ["eventId"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler({ eventId }, ctx) {
      requireAny(ctx.user, REVIEW, "publish events");
      const result = await api(ctx, { method: "POST", url: "/api/events/publish", body: { eventId }, user: ctx.user });
      return { message: result.message, event: summarise(await loadEvent(eventId)) };
    },
  },
  {
    name: "events_cancel",
    title: "Cancel event",
    feature: "events",
    permission: EDIT,
    description:
      "Cancel an event. For a published event this posts a cancellation in Discord and cancels the Discord " +
      "scheduled event, so confirm with the user first. Only reviewers can cancel approved or published events.",
    inputSchema: {
      type: "object",
      properties: { ...eventIdArg, reason: { type: "string", description: "Reason shown with the cancellation." } },
      required: ["eventId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async handler({ eventId, reason }, ctx) {
      requireAny(ctx.user, EDIT, "cancel events");
      const result = await api(ctx, {
        method: "POST",
        url: "/api/events/cancel",
        body: compact({ eventId, reason }),
        user: ctx.user,
      });
      return { message: result.message, event: summarise(await loadEvent(eventId)) };
    },
  },
  {
    name: "events_list_templates",
    title: "List event templates",
    feature: "events",
    permission: VIEW,
    description: "List the event templates (recurring or master events) that drafts can be generated from.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async handler() {
      const templates = await getTemplates();
      return templates.map((t) => ({
        templateId: t.templateId,
        title: t.title,
        recurrenceType: t.recurrenceType,
        recurrenceDays: t.recurrenceDays,
        defaultStartTime: t.defaultStartTime,
        defaultEndTime: t.defaultEndTime,
        timezone: t.timezone,
        active: t.isActive,
      }));
    },
  },
  {
    name: "events_create_from_template",
    title: "Create event from template",
    feature: "events",
    permission: EDIT,
    description:
      "Generate a draft event from a template. Give a date (YYYY-MM-DD), or leave it out to use the template's next scheduled date.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: { type: "integer", minimum: 1 },
        date: { type: "string", description: "Event date as YYYY-MM-DD. Required for master (one-off) templates." },
      },
      required: ["templateId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler({ templateId, date }, ctx) {
      requireAny(ctx.user, EDIT, "create events");
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError('"date" must look like 2026-11-20.');
      const result = await api(ctx, {
        method: "POST",
        url: "/api/events/templates/generate-draft",
        body: compact({ templateId, targetDate: date }),
        user: ctx.user,
      });
      const eventId = result.data?.eventId;
      return { message: result.message, event: eventId ? summarise(await loadEvent(eventId)) : result.data };
    },
  },
];
