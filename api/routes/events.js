/**
 * Events API Routes
 * All event management endpoints — protected by API token via verifyToken middleware.
 */

import {
  getEvents,
  getEventsInRange,
  getEventById,
  getUpcomingPublishedEvents,
  getAllPublishedEvents,
  createEvent,
  updateEvent,
  submitForReview,
  approveEvent,
  rejectEvent,
  revertToDraft,
  publishEvent,
  updatePublishedEvent,
  cancelEvent,
  deleteEvent,
  archiveEvent,
  upsertEventActions,
  upsertEventAnnouncements,
  getPendingReviewEvents,
  duplicateEvent,
} from "../../services/eventService.js";

import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  upsertTemplateAnnouncements,
} from "../../services/eventTemplateService.js";

import {
  runDiscordActionsForEvent,
  editEventDiscordMessage,
  editGuildScheduledEvent,
  postCancellationDiscordMessage,
  cancelGuildScheduledEvent,
  postEventDiscordMessage,
  createGuildScheduledEvent,
  postReviewRequestDiscordMessage,
} from "../../services/eventDiscordService.js";

import { ChannelType } from "discord.js";
import { client as discordClient } from "../../controllers/discordController.js";
import { required, optional } from "../common.js";
import { hasPermission as checkPermNode } from "../../lib/discord/permissions.mjs";
import { searchLinkedUsers } from "../../controllers/supportTicketController.js";
import { createRequire } from "module";
import path from "path";
const _require = createRequire(import.meta.url);
const config = _require(path.join(process.cwd(), "config.json"));

function actorFromReq(req) {
  const user = req.session?.user;
  return {
    actorId: user?.userId || null,
    actorName: user?.username || "System",
  };
}

function isReviewer(req) {
  return checkPermNode(req.session?.user?.permissions || [], "zander.web.events.review");
}

function isEditor(req) {
  const perms = req.session?.user?.permissions || [];
  return checkPermNode(perms, "zander.web.events.edit") || checkPermNode(perms, "zander.web.events.review");
}

export default function eventsApiRoute(app, _config, _db, features, _lang) {
  // ============================================================================
  // Public endpoints (no auth check beyond token)
  // ============================================================================

  /** GET /api/events/upcoming - public upcoming events list */
  app.get("/api/events/upcoming", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    try {
      const limit = Math.min(parseInt(req.query.limit || "20"), 50);
      const events = await getUpcomingPublishedEvents(limit);
      return res.send({ success: true, data: events });
    } catch (err) {
      console.error("[Events API] upcoming:", err);
      return res.send({ success: false, message: "Failed to fetch upcoming events" });
    }
  });

  /** GET /api/events/published - all published events */
  app.get("/api/events/published", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    try {
      const page = Math.max(parseInt(req.query.page || "1"), 1);
      const limit = Math.min(parseInt(req.query.limit || "20"), 100);
      const result = await getAllPublishedEvents(page, limit);
      return res.send({ success: true, ...result });
    } catch (err) {
      console.error("[Events API] published:", err);
      return res.send({ success: false, message: "Failed to fetch published events" });
    }
  });

  // ============================================================================
  // User search (linked users only — for host assignment)
  // ============================================================================

  /** GET /api/events/users/search - search linked players for host assignment */
  app.get("/api/events/users/search", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!req.session?.user) return res.status(401).send({ results: [] });
    try {
      const results = await searchLinkedUsers(req.query.q || "");
      return res.send({ results });
    } catch (err) {
      console.error("[Events API] users/search:", err);
      return res.status(500).send({ results: [] });
    }
  });

  /** GET /api/events/discord/voice-channels - list voice channels for location picker */
  app.get("/api/events/discord/voice-channels", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!req.session?.user) return res.status(401).send({ channels: [] });
    try {
      const guildId = _config.discord?.guildId ?? process.env.DISCORD_GUILD_ID;
      if (!guildId || !discordClient?.isReady?.()) return res.send({ channels: [] });

      const guild = await discordClient.guilds.fetch(guildId);
      const all = await guild.channels.fetch();
      const channels = [];
      all.forEach(ch => {
        if (ch && ch.type === ChannelType.GuildVoice) {
          channels.push({ id: ch.id, name: ch.name, category: ch.parent?.name || null });
        }
      });
      channels.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
      return res.send({ channels });
    } catch (err) {
      console.error("[Events API] discord/voice-channels:", err);
      return res.send({ channels: [] });
    }
  });

  /** GET /api/events/discord/text-channels - list text channels for action picker */
  app.get("/api/events/discord/text-channels", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!req.session?.user) return res.status(401).send({ channels: [] });
    try {
      const guildId = _config.discord?.guildId ?? process.env.DISCORD_GUILD_ID;
      if (!guildId || !discordClient?.isReady?.()) return res.send({ channels: [] });

      const guild = await discordClient.guilds.fetch(guildId);
      const all = await guild.channels.fetch();
      const channels = [];
      all.forEach(ch => {
        if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) {
          channels.push({ id: ch.id, name: ch.name, category: ch.parent?.name || null });
        }
      });
      channels.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
      return res.send({ channels });
    } catch (err) {
      console.error("[Events API] discord/text-channels:", err);
      return res.send({ channels: [] });
    }
  });

  // ============================================================================
  // Event list / search (dashboard)
  // ============================================================================

  /** GET /api/events/get - get events with filters */
  app.get("/api/events/get", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    try {
      const result = await getEvents({
        status: req.query.status || null,
        statuses: req.query.statuses ? req.query.statuses.split(",").filter(Boolean) : null,
        eventType: req.query.eventType || null,
        search: req.query.search || null,
        templateId: req.query.templateId ? parseInt(req.query.templateId) : null,
        hidePast: req.query.hidePast === "true" || req.query.hidePast === "1",
        page: Math.max(parseInt(req.query.page || "1"), 1),
        limit: Math.min(parseInt(req.query.limit || "50"), 200),
      });
      return res.send({ success: true, ...result });
    } catch (err) {
      console.error("[Events API] get:", err);
      return res.send({ success: false, message: "Failed to fetch events" });
    }
  });

  /** GET /api/events/calendar - events in date range */
  app.get("/api/events/calendar", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    try {
      const { start, end } = req.query;
      if (!start || !end) return res.send({ success: false, message: "start and end query params required" });

      const events = await getEventsInRange(start, end);
      return res.send({ success: true, data: events });
    } catch (err) {
      console.error("[Events API] calendar:", err);
      return res.send({ success: false, message: "Failed to fetch calendar events" });
    }
  });

  /** GET /api/events/pending-review */
  app.get("/api/events/pending-review", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    try {
      const events = await getPendingReviewEvents();
      return res.send({ success: true, data: events });
    } catch (err) {
      console.error("[Events API] pending-review:", err);
      return res.send({ success: false, message: "Failed to fetch pending events" });
    }
  });

  /** GET /api/events/single?eventId=X */
  app.get("/api/events/single", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    try {
      const eventId = req.query.eventId;
      if (!eventId) return res.send({ success: false, message: "eventId required" });

      const event = await getEventById(eventId);
      if (!event) return res.send({ success: false, message: "Event not found" });

      return res.send({ success: true, data: event });
    } catch (err) {
      console.error("[Events API] single:", err);
      return res.send({ success: false, message: "Failed to fetch event" });
    }
  });

  // ============================================================================
  // Event lifecycle
  // ============================================================================

  /** POST /api/events/create */
  app.post("/api/events/create", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!isEditor(req)) return res.status(403).send({ success: false, message: "You do not have permission to create events." });

    const body = req.body;
    if (!body?.title) return res.send({ success: false, message: "title is required" });
    if (!body?.startAt) return res.send({ success: false, message: "startAt is required" });
    if (!body?.endAt) return res.send({ success: false, message: "endAt is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await createEvent(body, actorId, actorName);
      return res.send({ success: true, data: event, message: "Event draft created" });
    } catch (err) {
      console.error("[Events API] create:", err);
      return res.send({ success: false, message: err.message || "Failed to create event" });
    }
  });

  /** POST /api/events/update */
  app.post("/api/events/update", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!isEditor(req)) return res.status(403).send({ success: false, message: "You do not have permission to edit events." });

    const body = req.body;
    if (!body?.eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const existing = await getEventById(body.eventId);
      if (!existing) return res.send({ success: false, message: "Event not found" });

      // Approved events may only be modified by reviewers
      if (existing.status === "approved" && !isReviewer(req)) {
        return res.status(403).send({ success: false, message: "Only approvers can edit an approved event." });
      }

      const { actorId, actorName } = actorFromReq(req);
      const event = await updateEvent(body.eventId, body, actorId, actorName);
      return res.send({ success: true, data: event, message: "Event updated" });
    } catch (err) {
      console.error("[Events API] update:", err);
      return res.send({ success: false, message: err.message || "Failed to update event" });
    }
  });

  /** POST /api/events/submit-review */
  app.post("/api/events/submit-review", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!isEditor(req)) return res.status(403).send({ success: false, message: "You do not have permission to submit events for review." });

    const eventId = req.body?.eventId;
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await submitForReview(eventId, actorId, actorName);

      // Fire review notification asynchronously — don't block the response
      setImmediate(async () => {
        try {
          const reviewChannelId = config?.events?.reviewChannelId || null;
          const siteBaseUrl = config?.siteConfiguration?.siteUrl || process.env.siteAddress || "";
          if (reviewChannelId) {
            const fullEvent = await getEventById(eventId);
            await postReviewRequestDiscordMessage(fullEvent, actorName, reviewChannelId, siteBaseUrl);
          }
        } catch (e) {
          console.error("[Events] Review notification failed:", e.message);
        }
      });

      return res.send({ success: true, data: event, message: "Event submitted for review" });
    } catch (err) {
      console.error("[Events API] submit-review:", err);
      return res.send({ success: false, message: err.message || "Failed to submit event" });
    }
  });

  /** POST /api/events/approve */
  app.post("/api/events/approve", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const eventId = req.body?.eventId;
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await approveEvent(eventId, actorId, actorName);

      // approveEvent auto-publishes; run Discord actions asynchronously
      const fullEvent = await getEventById(eventId);
      setImmediate(async () => {
        try {
          const discordCfg = {
            channelId: config?.events?.discordChannelId || null,
            guildId: config?.discord?.guildId || config?.events?.discordGuildId || null,
            siteBaseUrl: config?.siteConfiguration?.siteUrl || process.env.siteAddress || "",
          };
          await runDiscordActionsForEvent(fullEvent, "on_publish", discordCfg);
        } catch (e) {
          console.error("[Events] Discord actions failed on approve:", e.message);
        }
      });

      return res.send({ success: true, data: event, message: "Event approved and published" });
    } catch (err) {
      console.error("[Events API] approve:", err);
      return res.send({ success: false, message: err.message || "Failed to approve event" });
    }
  });

  /** POST /api/events/reject */
  app.post("/api/events/reject", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId, rejectionNote } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await rejectEvent(eventId, actorId, actorName, rejectionNote);
      return res.send({ success: true, data: event, message: "Event rejected" });
    } catch (err) {
      console.error("[Events API] reject:", err);
      return res.send({ success: false, message: err.message || "Failed to reject event" });
    }
  });

  /** POST /api/events/revert-to-draft */
  app.post("/api/events/revert-to-draft", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!isReviewer(req)) return res.status(403).send({ success: false, message: "Only reviewers can revert events to draft." });

    const { eventId } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await revertToDraft(eventId, actorId, actorName);
      return res.send({ success: true, data: event, message: "Event reverted to draft" });
    } catch (err) {
      console.error("[Events API] revert-to-draft:", err);
      return res.send({ success: false, message: err.message || "Failed to revert event" });
    }
  });

  /** POST /api/events/publish */
  app.post("/api/events/publish", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await publishEvent(eventId, actorId, actorName);

      // Reload with actions
      const fullEvent = await getEventById(eventId);

      // Run downstream actions asynchronously (don't block the response)
      setImmediate(async () => {
        try {
          const discordCfg = {
            channelId: config?.events?.discordChannelId || null,
            guildId: config?.discord?.guildId || config?.events?.discordGuildId || null,
            siteBaseUrl: config?.siteConfiguration?.siteUrl || process.env.siteAddress || "",
          };
          await runDiscordActionsForEvent(fullEvent, "on_publish", discordCfg);
        } catch (e) {
          console.error("[Events] Discord actions failed:", e.message);
        }
      });

      return res.send({ success: true, data: event, message: "Event published" });
    } catch (err) {
      console.error("[Events API] publish:", err);
      return res.send({ success: false, message: err.message || "Failed to publish event" });
    }
  });

  /** POST /api/events/update-published */
  app.post("/api/events/update-published", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const body = req.body || {};
    if (!body?.eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await updatePublishedEvent(body.eventId, body, actorId, actorName);

      // Run downstream sync asynchronously
      const fullEvent = await getEventById(body.eventId);
      setImmediate(async () => {
        try {
          const discordCfg = {
            channelId: config?.events?.discordChannelId || null,
            guildId: config?.discord?.guildId || config?.events?.discordGuildId || null,
            siteBaseUrl: config?.siteConfiguration?.siteUrl || process.env.siteAddress || "",
          };

          const hasUpdateActions = (fullEvent.actions || []).some(a => a.enabled && a.trigger === "on_update");
          if (hasUpdateActions) {
            await runDiscordActionsForEvent(fullEvent, "on_update", discordCfg);
          } else {
            // Fallback for events created before on_update actions existed
            const guildId = discordCfg.guildId;
            if (fullEvent.discordMessageId && fullEvent.discordChannelId) {
              await editEventDiscordMessage(fullEvent, fullEvent.discordChannelId, fullEvent.discordMessageId, discordCfg.siteBaseUrl).catch(e =>
                console.error("[Events] Discord message update failed:", e.message)
              );
            }
            if (fullEvent.discordGuildEventId && guildId) {
              await editGuildScheduledEvent(fullEvent, guildId, fullEvent.discordGuildEventId).catch(e =>
                console.error("[Events] Guild event update failed:", e.message)
              );
            }
          }
        } catch (e) {
          console.error("[Events] Discord sync failed:", e.message);
        }
      });

      return res.send({ success: true, data: event, message: "Published event updated and sync triggered" });
    } catch (err) {
      console.error("[Events API] update-published:", err);
      return res.send({ success: false, message: err.message || "Failed to update event" });
    }
  });

  /** POST /api/events/cancel */
  app.post("/api/events/cancel", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId, reason } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const existing = await getEventById(eventId);
      if (!existing) return res.send({ success: false, message: "Event not found" });

      // All cancellations require at least edit permission
      if (!isEditor(req)) {
        return res.status(403).send({ success: false, message: "You do not have permission to cancel events." });
      }
      // Approved and published events can only be cancelled by reviewers
      if (["approved", "published"].includes(existing.status) && !isReviewer(req)) {
        return res.status(403).send({ success: false, message: "Only approvers can cancel an approved or live event." });
      }

      const { actorId, actorName } = actorFromReq(req);
      const event = await cancelEvent(eventId, actorId, actorName, reason);

      const fullEvent = await getEventById(eventId, true);
      setImmediate(async () => {
        try {
          const guildId = config?.discord?.guildId || config?.events?.discordGuildId || null;
          const channelId = config?.events?.discordChannelId || config?.discord?.eventsChannelId || null;
          const discordCfg = { guildId, channelId, siteBaseUrl: config?.siteAddress || "" };

          const hasCancelActions = (fullEvent.actions || []).some(
            (a) => a.enabled && a.trigger === "on_cancel"
          );

          if (hasCancelActions) {
            await runDiscordActionsForEvent(fullEvent, "on_cancel", discordCfg);
          } else {
            // Fallback for legacy events without on_cancel actions
            const notifyChannel = fullEvent.discordChannelId || channelId;
            if (notifyChannel) {
              await postCancellationDiscordMessage(fullEvent, notifyChannel).catch((e) =>
                console.error("[Events] Cancel message failed:", e.message)
              );
            }
            if (fullEvent.discordGuildEventId && guildId) {
              await cancelGuildScheduledEvent(fullEvent, guildId, fullEvent.discordGuildEventId).catch((e) =>
                console.error("[Events] Guild event cancel failed:", e.message)
              );
            }
          }
        } catch (e) {
          console.error("[Events] Discord cancel sync failed:", e.message);
        }
      });

      return res.send({ success: true, data: event, message: "Event cancelled" });
    } catch (err) {
      console.error("[Events API] cancel:", err);
      return res.send({ success: false, message: err.message || "Failed to cancel event" });
    }
  });

  /** POST /api/events/resync-discord — re-post message and/or recreate guild event for a published event */
  app.post("/api/events/resync-discord", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });
    if (!isReviewer(req)) return res.status(403).send({ success: false, message: "Only reviewers can resync Discord." });

    const { eventId, resyncMessage, resyncGuildEvent } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const event = await getEventById(eventId);
      if (!event) return res.send({ success: false, message: "Event not found" });
      if (event.status !== "published") return res.send({ success: false, message: "Only published events can be resynced." });

      const guildId = config?.discord?.guildId || config?.events?.discordGuildId || null;
      const siteBaseUrl = config?.siteConfiguration?.siteUrl || process.env.siteAddress || "";

      // Resolve channel: stored on event > action config > global config
      const msgAction = (event.actions || []).find(
        (a) => a.enabled && a.trigger === "on_publish" && a.actionType === "discord_message"
      );
      const channelId =
        event.discordChannelId ||
        msgAction?.config?.channelId ||
        config?.events?.discordChannelId ||
        null;

      // Resolve guild from action config if not set globally
      const guildAction = (event.actions || []).find(
        (a) => a.enabled && a.trigger === "on_publish" && a.actionType === "discord_guild_event"
      );
      const resolvedGuildId = guildId || guildAction?.config?.guildId || null;

      const results = { message: null, guildEvent: null };

      if (resyncMessage) {
        try {
          if (event.discordMessageId && event.discordChannelId) {
            await editEventDiscordMessage(event, event.discordChannelId, event.discordMessageId, siteBaseUrl);
            results.message = "updated";
          } else {
            if (!channelId) throw new Error("No channel configured — set a channel in the event's Discord Message action");
            await postEventDiscordMessage(event, channelId, siteBaseUrl);
            results.message = "posted";
          }
        } catch (e) {
          console.error("[Events] resync message failed:", e.message);
          results.message = `failed: ${e.message}`;
        }
      }

      if (resyncGuildEvent) {
        try {
          if (event.discordGuildEventId && resolvedGuildId) {
            await editGuildScheduledEvent(event, resolvedGuildId, event.discordGuildEventId);
            results.guildEvent = "updated";
          } else if (resolvedGuildId) {
            await createGuildScheduledEvent(event, resolvedGuildId);
            results.guildEvent = "created";
          } else {
            results.guildEvent = "skipped: no guild configured";
          }
        } catch (e) {
          console.error("[Events] resync guild event failed:", e.message);
          results.guildEvent = `failed: ${e.message}`;
        }
      }

      return res.send({ success: true, results, message: "Discord resync complete" });
    } catch (err) {
      console.error("[Events API] resync-discord:", err);
      return res.send({ success: false, message: err.message || "Resync failed" });
    }
  });

  /** POST /api/events/archive */
  app.post("/api/events/archive", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await archiveEvent(eventId, actorId, actorName);
      return res.send({ success: true, data: event, message: "Event archived" });
    } catch (err) {
      console.error("[Events API] archive:", err);
      return res.send({ success: false, message: err.message || "Failed to archive event" });
    }
  });

  /** POST /api/events/delete */
  app.post("/api/events/delete", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await deleteEvent(eventId, actorId, actorName);
      return res.send({ success: true, data: event, message: "Event deleted" });
    } catch (err) {
      console.error("[Events API] delete:", err);
      return res.send({ success: false, message: err.message || "Failed to delete event" });
    }
  });

  /** POST /api/events/duplicate */
  app.post("/api/events/duplicate", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const event = await duplicateEvent(eventId, actorId, actorName);
      return res.send({ success: true, data: event, message: "Event duplicated as draft" });
    } catch (err) {
      console.error("[Events API] duplicate:", err);
      return res.send({ success: false, message: err.message || "Failed to duplicate event" });
    }
  });

  // ============================================================================
  // Actions & Announcements
  // ============================================================================

  /** POST /api/events/actions/update */
  app.post("/api/events/actions/update", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId, actions } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      await upsertEventActions(eventId, actions || [], actorId, actorName);
      return res.send({ success: true, message: "Actions updated" });
    } catch (err) {
      console.error("[Events API] actions/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update actions" });
    }
  });

  /** POST /api/events/announcements/update */
  app.post("/api/events/announcements/update", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { eventId, announcements } = req.body || {};
    if (!eventId) return res.send({ success: false, message: "eventId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      await upsertEventAnnouncements(eventId, announcements || [], actorId, actorName);
      return res.send({ success: true, message: "Announcements updated" });
    } catch (err) {
      console.error("[Events API] announcements/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update announcements" });
    }
  });

  // ============================================================================
  // Templates
  // ============================================================================

  /** GET /api/events/templates/get */
  app.get("/api/events/templates/get", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    try {
      const templates = await getTemplates();
      return res.send({ success: true, data: templates });
    } catch (err) {
      console.error("[Events API] templates/get:", err);
      return res.send({ success: false, message: "Failed to fetch templates" });
    }
  });

  /** GET /api/events/templates/single?templateId=X */
  app.get("/api/events/templates/single", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { templateId } = req.query;
    if (!templateId) return res.send({ success: false, message: "templateId required" });

    try {
      const tmpl = await getTemplateById(templateId);
      if (!tmpl) return res.send({ success: false, message: "Template not found" });
      return res.send({ success: true, data: tmpl });
    } catch (err) {
      console.error("[Events API] templates/single:", err);
      return res.send({ success: false, message: "Failed to fetch template" });
    }
  });

  /** POST /api/events/templates/create */
  app.post("/api/events/templates/create", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    if (!req.body?.title) return res.send({ success: false, message: "title is required" });

    try {
      const { actorId } = actorFromReq(req);
      const tmpl = await createTemplate(req.body, actorId);
      return res.send({ success: true, data: tmpl, message: "Template created" });
    } catch (err) {
      console.error("[Events API] templates/create:", err);
      return res.send({ success: false, message: err.message || "Failed to create template" });
    }
  });

  /** POST /api/events/templates/update */
  app.post("/api/events/templates/update", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { templateId } = req.body || {};
    if (!templateId) return res.send({ success: false, message: "templateId is required" });

    try {
      const { actorId } = actorFromReq(req);
      const tmpl = await updateTemplate(templateId, req.body, actorId);
      return res.send({ success: true, data: tmpl, message: "Template updated" });
    } catch (err) {
      console.error("[Events API] templates/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update template" });
    }
  });

  /** POST /api/events/templates/delete */
  app.post("/api/events/templates/delete", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { templateId } = req.body || {};
    if (!templateId) return res.send({ success: false, message: "templateId is required" });

    try {
      await deleteTemplate(templateId);
      return res.send({ success: true, message: "Template deleted" });
    } catch (err) {
      console.error("[Events API] templates/delete:", err);
      return res.send({ success: false, message: err.message || "Failed to delete template" });
    }
  });

  /** POST /api/events/templates/announcements/update */
  app.post("/api/events/templates/announcements/update", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { templateId, announcements } = req.body || {};
    if (!templateId) return res.send({ success: false, message: "templateId is required" });

    try {
      const tmpl = await getTemplateById(templateId);
      if (!tmpl) return res.send({ success: false, message: "Template not found" });

      await upsertTemplateAnnouncements(templateId, announcements || []);
      return res.send({ success: true, message: "Template announcements updated" });
    } catch (err) {
      console.error("[Events API] templates/announcements/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update template announcements" });
    }
  });

  /** POST /api/events/templates/generate-draft - manually trigger draft generation */
  app.post("/api/events/templates/generate-draft", async (req, res) => {
    if (!features.events) return res.send({ success: false, message: "Events feature disabled" });

    const { templateId, targetDate } = req.body || {};
    if (!templateId) return res.send({ success: false, message: "templateId is required" });

    try {
      const { actorId, actorName } = actorFromReq(req);
      const tmpl = await getTemplateById(templateId);
      if (!tmpl) return res.send({ success: false, message: "Template not found" });

      const { generateDraftFromTemplate, computeNextEventDate } = await import("../../services/eventTemplateService.js");

      const date = targetDate ? new Date(targetDate) : computeNextEventDate(tmpl);
      if (!date) return res.send({ success: false, message: "Could not determine next event date" });

      const event = await generateDraftFromTemplate(tmpl, date, actorId, actorName);
      return res.send({ success: true, data: event, message: "Draft event generated from template" });
    } catch (err) {
      console.error("[Events API] templates/generate-draft:", err);
      return res.send({ success: false, message: err.message || "Failed to generate draft" });
    }
  });
}
