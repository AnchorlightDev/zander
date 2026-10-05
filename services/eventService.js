/**
 * Event Service
 * Core CRUD operations and lifecycle management for the Events Calendar module.
 */

import { prisma } from "../controllers/databaseController.js";
import { sanitizeForumHtml } from "../lib/htmlSanitize.js";
import { EVENT_VISIBILITY, normaliseRankSlugs } from "../lib/eventAccess.js";
import {
  SITE_ANNOUNCEMENT_PLATFORMS,
  discordScheduledFor,
  missingDefaults,
  parseOffsetMinutes,
  siteAnnouncementWindow,
} from "../lib/eventAnnouncements.js";

// Valid status transitions
const STATUS_TRANSITIONS = {
  draft: ["pending_review", "cancelled"],
  pending_review: ["approved", "rejected", "draft"],
  approved: ["published", "rejected", "draft"],
  published: ["cancelled", "archived"],
  rejected: ["draft"],
  cancelled: ["archived"],
  archived: [],
};

/**
 * Generate a URL-safe slug from a title + date, ensuring uniqueness.
 */
async function generateSlug(title, startAt, existingSlug = null) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 80);

  const datePart = new Date(startAt).toISOString().slice(0, 10);
  let candidate = `${base}-${datePart}`;

  if (existingSlug && existingSlug === candidate) return candidate;

  let suffix = 0;
  while (true) {
    const slug = suffix === 0 ? candidate : `${candidate}-${suffix}`;
    const existing = await prisma.events.findUnique({ where: { slug } });
    if (!existing || (existingSlug && existing.slug === existingSlug)) {
      return slug;
    }
    suffix++;
  }
}

/**
 * Move a published event's announcements after its start or end time changes:
 * unsent Discord announcements get a new send time, and site announcements
 * already created get a new display window. Unpublished events have nothing
 * scheduled yet -- times are worked out when they are published.
 */
async function recalculateAnnouncementSchedules(eventId) {
  const event = await prisma.events.findUnique({ where: { eventId } });
  if (!event || event.status !== "published") return;

  const announcements = await prisma.event_announcements.findMany({
    where: { eventId, enabled: true },
  });

  for (const ann of announcements) {
    if ((ann.platform || "discord") === "discord") {
      if (ann.status !== "pending" || ann.triggerType === "on_publish") continue;
      const scheduledFor = discordScheduledFor(ann, event.startAt, event.endAt);
      if (scheduledFor) {
        await prisma.event_announcements.update({ where: { id: ann.id }, data: { scheduledFor } });
      }
    } else if (ann.linkedAnnouncementId) {
      await prisma.announcements.updateMany({
        where: { announcementId: ann.linkedAnnouncementId },
        data: { ...siteAnnouncementWindow(ann, event.startAt, event.endAt), updatedDate: new Date() },
      });
    }
  }

  for (const ann of await legacyQueuedDiscordAnnouncements(eventId)) {
    if (ann.triggerType === "on_publish") continue;
    const scheduledFor = discordScheduledFor(ann, event.startAt, event.endAt);
    if (!scheduledFor) continue;
    await prisma.scheduledDiscordMessages.updateMany({
      where: { channelId: ann.channelId, scheduledFor: ann.scheduledFor, status: "scheduled", sentAt: null },
      data: { scheduledFor },
    });
    await prisma.event_announcements.update({ where: { id: ann.id }, data: { scheduledFor } });
  }
}

/**
 * Discord announcements of events published before announcements were sent by
 * the event announcement cron: they were copied into scheduledDiscordMessages
 * and marked "sent" at publish time without a sentAt. Matched back to their
 * queue entry by channel and send time, so cancel and reschedule reach them.
 */
async function legacyQueuedDiscordAnnouncements(eventId) {
  return prisma.event_announcements.findMany({
    where: {
      eventId,
      platform: "discord",
      status: "sent",
      sentAt: null,
      scheduledFor: { gt: new Date() },
      channelId: { not: null },
    },
  });
}

/**
 * Stop everything an event still has queued: unsent Discord announcements are
 * cancelled and site announcements it created are switched off.
 */
async function stopEventAnnouncements(eventId) {
  await prisma.event_announcements.updateMany({
    where: { eventId, status: "pending" },
    data: { status: "cancelled" },
  });

  for (const ann of await legacyQueuedDiscordAnnouncements(eventId)) {
    await prisma.scheduledDiscordMessages.updateMany({
      where: { channelId: ann.channelId, scheduledFor: ann.scheduledFor, status: "scheduled", sentAt: null },
      data: { status: "failed", lastError: "Event cancelled" },
    });
    await prisma.event_announcements.update({ where: { id: ann.id }, data: { status: "cancelled" } });
  }

  const linked = await prisma.event_announcements.findMany({
    where: { eventId, linkedAnnouncementId: { not: null } },
    select: { linkedAnnouncementId: true },
  });
  if (linked.length > 0) {
    await prisma.announcements.updateMany({
      where: { announcementId: { in: linked.map((l) => l.linkedAnnouncementId) } },
      data: { enabled: false, updatedDate: new Date() },
    });
  }
}

/**
 * Write an audit log entry for an event.
 */
export async function logEventAudit(eventId, actorId, actorName, action, details = null, before = null, after = null) {
  await prisma.event_audit_logs.create({
    data: {
      eventId,
      actorId: actorId || null,
      actorName: actorName || null,
      action,
      details: details || null,
      beforeSnapshot: before || undefined,
      afterSnapshot: after || undefined,
    },
  });
}

/**
 * Replace an event's allowed-rank list.
 *
 * Delete-then-insert rather than a diff: the list is a handful of rows edited
 * by hand in the dashboard, so the simpler form is worth more than the saved
 * writes.
 */
async function syncRankAccess(eventId, slugs) {
  const rankSlugs = normaliseRankSlugs(slugs);

  await prisma.event_rank_access.deleteMany({ where: { eventId: parseInt(eventId) } });

  if (rankSlugs.length > 0) {
    await prisma.event_rank_access.createMany({
      data: rankSlugs.map((rankSlug) => ({ eventId: parseInt(eventId), rankSlug })),
    });
  }

  return rankSlugs;
}

/** Fall back to "public" for anything not in the known set, so a bad payload cannot invent a visibility. */
function coerceVisibility(value, fallback = "public") {
  const v = String(value ?? "").trim().toLowerCase();
  return EVENT_VISIBILITY.includes(v) ? v : fallback;
}

/**
 * Get a list of events with optional filters.
 */
export async function getEvents({
  status = null,
  statuses = null,
  eventType = null,
  visibility = null,
  search = null,
  templateId = null,
  includeDeleted = false,
  hidePast = false,
  page = 1,
  limit = 50,
} = {}) {
  const where = {};

  if (!includeDeleted) where.deletedAt = null;
  if (statuses && statuses.length > 0) {
    where.status = { in: statuses };
  } else if (status) {
    where.status = status;
  }
  if (hidePast) where.endAt = { gte: new Date() };
  if (eventType) where.eventType = eventType;
  if (visibility) where.visibility = visibility;
  if (templateId) where.templateId = templateId;

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { description: { contains: search } },
    ];
  }

  const [total, events] = await Promise.all([
    prisma.events.count({ where }),
    prisma.events.findMany({
      where,
      include: {
        hosts: true,
        template: { select: { templateId: true, title: true } },
        rankAccess: true,
      },
      orderBy: { startAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { total, events, page, limit };
}

/**
 * Get events within a date range for calendar view.
 */
export async function getEventsInRange(startDate, endDate, includeDeleted = false) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error(`Invalid date range: start=${startDate}, end=${endDate}`);
  }

  const where = {
    startAt: { lt: end },
    endAt: { gt: start },
  };
  if (!includeDeleted) where.deletedAt = null;

  return prisma.events.findMany({
    where,
    include: { hosts: true, rankAccess: true },
    orderBy: { startAt: "asc" },
  });
}

/**
 * Get a single event by ID with full relations.
 */
export async function getEventById(eventId, includeDeleted = false) {
  const event = await prisma.events.findUnique({
    where: { eventId: parseInt(eventId) },
    include: {
      hosts: true,
      actions: true,
      announcements: { orderBy: { scheduledFor: "asc" } },
      auditLogs: { orderBy: { createdAt: "desc" }, take: 50 },
      template: { select: { templateId: true, title: true } },
      rankAccess: true,
    },
  });

  if (!event) return null;
  if (!includeDeleted && event.deletedAt) return null;

  return event;
}

/**
 * The `where` fragment describing which published events a given visitor is
 * allowed to see *at all* (they may still only get a locked teaser).
 *
 * Done in SQL rather than by filtering the result set in JS so pagination
 * counts stay correct — post-filtering would hand the listing page a short
 * page and a total that includes events the visitor can never see.
 *
 * @param viewerRanks Normalised rank slugs from lib/eventAccess.js.
 * @param isStaff     Staff see rank-locked and private events unredacted.
 */
function publicVisibilityWhere(viewerRanks = [], isStaff = false) {
  if (isStaff) return {};

  const clauses = [
    { visibility: "public" },
    // Locked but advertised — rendered as a teaser with an unlock prompt.
    { visibility: "rank", teaserPublic: true },
    // A rank-locked event with no ranks chosen locks out the people it was
    // built for, so it falls back to public rather than vanishing.
    { visibility: "rank", rankAccess: { none: {} } },
  ];

  if (viewerRanks.length > 0) {
    clauses.push({
      visibility: "rank",
      rankAccess: { some: { rankSlug: { in: viewerRanks } } },
    });
  }

  return { OR: clauses };
}

/**
 * Get a single published event by slug (public-facing).
 *
 * Returns rank-locked events too — deciding whether to redact them is the
 * route's job, via resolveEventAccess() — but still withholds 'private' ones
 * from non-staff.
 */
export async function getPublishedEventBySlug(slug, viewerRanks = [], isStaff = false) {
  return prisma.events.findFirst({
    where: {
      slug,
      status: "published",
      deletedAt: null,
      ...publicVisibilityWhere(viewerRanks, isStaff),
    },
    include: { hosts: true, rankAccess: true },
  });
}

/**
 * Get upcoming published events for the public listing.
 */
export async function getUpcomingPublishedEvents(limit = 20, viewerRanks = [], isStaff = false) {
  return prisma.events.findMany({
    where: {
      status: "published",
      deletedAt: null,
      endAt: { gte: new Date() },
      ...publicVisibilityWhere(viewerRanks, isStaff),
    },
    include: { hosts: true, rankAccess: true },
    orderBy: { startAt: "asc" },
    take: limit,
  });
}

/**
 * Get all published events for listing (past + upcoming).
 */
export async function getAllPublishedEvents(page = 1, limit = 20, viewerRanks = [], isStaff = false) {
  const where = {
    status: "published",
    deletedAt: null,
    ...publicVisibilityWhere(viewerRanks, isStaff),
  };
  const [total, events] = await Promise.all([
    prisma.events.count({ where }),
    prisma.events.findMany({
      where,
      include: { hosts: true, rankAccess: true },
      orderBy: { startAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return { total, events, page, limit };
}

/**
 * Create a new event draft.
 */
export async function createEvent(data, actorId, actorName) {
  const slug = await generateSlug(data.title, data.startAt);

  const event = await prisma.events.create({
    data: {
      title: data.title,
      slug,
      description: data.description ? sanitizeForumHtml(data.description) : null,
      teaserDescription: data.teaserDescription ? sanitizeForumHtml(data.teaserDescription) : null,
      eventType: data.eventType || "once",
      startAt: new Date(data.startAt),
      endAt: new Date(data.endAt),
      timezone: data.timezone || "UTC",
      status: "draft",
      visibility: coerceVisibility(data.visibility),
      teaserPublic: data.teaserPublic !== undefined ? Boolean(data.teaserPublic) : true,
      locationLabel: data.locationLabel || null,
      locationType: data.locationType || null,
      locationDiscordChannelId: data.locationDiscordChannelId || null,
      serverName: data.serverName || null,
      serverIp: data.serverIp || null,
      externalLinks: data.externalLinks || undefined,
      bannerUrl: data.bannerUrl || null,
      logoUrl: data.logoUrl || null,
      tags: data.tags || undefined,
      featured: data.featured || false,
      creatorId: actorId,
      // Form posts send the template's ID as a string ("3"); the column is an Int.
      templateId: Number.parseInt(data.templateId, 10) || null,
    },
  });

  // Allowed ranks (only meaningful for visibility === "rank", but stored
  // either way so switching visibility back and forth keeps the selection)
  if (data.allowedRanks !== undefined) {
    await syncRankAccess(event.eventId, data.allowedRanks);
  }

  // Create hosts
  if (Array.isArray(data.hosts) && data.hosts.length > 0) {
    await prisma.event_hosts.createMany({
      data: data.hosts.map((h) => ({
        eventId: event.eventId,
        userId: h.userId ? parseInt(h.userId) : null,
        discordUserId: h.discordUserId || null,
        displayName: h.displayName || null,
        role: h.role || "host",
      })),
    });
  }

  // Create default actions
  const defaultActions = [
    { actionType: "discord_message", trigger: "on_publish", enabled: true, config: {} },
    { actionType: "discord_guild_event", trigger: "on_publish", enabled: true, config: {} },
    { actionType: "website_page", trigger: "on_publish", enabled: true, config: {} },
    { actionType: "discord_message", trigger: "on_update", enabled: true, config: {} },
    { actionType: "discord_guild_event", trigger: "on_update", enabled: true, config: {} },
    { actionType: "discord_message", trigger: "on_cancel", enabled: true, config: {} },
    { actionType: "discord_guild_event", trigger: "on_cancel", enabled: true, config: {} },
  ];
  await prisma.event_actions.createMany({
    data: defaultActions.map((a) => ({ ...a, eventId: event.eventId })),
  });

  await logEventAudit(event.eventId, actorId, actorName, "created", "Event draft created");

  return event;
}

/**
 * Update an event draft (allowed for draft/rejected status).
 */
export async function updateEvent(eventId, data, actorId, actorName) {
  const existing = await getEventById(eventId);
  if (!existing) throw new Error("Event not found");

  const updateData = {};

  if (data.title !== undefined) {
    updateData.title = data.title;
    updateData.slug = await generateSlug(data.title, data.startAt || existing.startAt, existing.slug);
  }
  // Summernote rich text — sanitized on write because events-view.ejs renders
  // it unescaped (<%- ev.description %>).
  if (data.description !== undefined)
    updateData.description = data.description ? sanitizeForumHtml(data.description) : null;
  // Rendered unescaped wherever a locked event is shown, so sanitized on write
  // for the same reason as description.
  if (data.teaserDescription !== undefined)
    updateData.teaserDescription = data.teaserDescription
      ? sanitizeForumHtml(data.teaserDescription)
      : null;
  if (data.eventType !== undefined) updateData.eventType = data.eventType;
  if (data.startAt !== undefined) updateData.startAt = new Date(data.startAt);
  if (data.endAt !== undefined) updateData.endAt = new Date(data.endAt);
  if (data.timezone !== undefined) updateData.timezone = data.timezone;
  if (data.visibility !== undefined)
    updateData.visibility = coerceVisibility(data.visibility, existing.visibility);
  if (data.teaserPublic !== undefined) updateData.teaserPublic = Boolean(data.teaserPublic);
  if (data.locationLabel !== undefined) updateData.locationLabel = data.locationLabel;
  if (data.locationType !== undefined) updateData.locationType = data.locationType || null;
  if (data.locationDiscordChannelId !== undefined) updateData.locationDiscordChannelId = data.locationDiscordChannelId || null;
  if (data.serverName !== undefined) updateData.serverName = data.serverName;
  if (data.serverIp !== undefined) updateData.serverIp = data.serverIp;
  if (data.externalLinks !== undefined) updateData.externalLinks = data.externalLinks;
  if (data.bannerUrl !== undefined) updateData.bannerUrl = data.bannerUrl;
  if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
  if (data.tags !== undefined) updateData.tags = data.tags;
  if (data.featured !== undefined) updateData.featured = data.featured;

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: updateData,
  });

  // Update allowed ranks if provided
  if (data.allowedRanks !== undefined) {
    await syncRankAccess(eventId, data.allowedRanks);
  }

  // Update hosts if provided
  if (Array.isArray(data.hosts)) {
    await prisma.event_hosts.deleteMany({ where: { eventId: parseInt(eventId) } });
    if (data.hosts.length > 0) {
      await prisma.event_hosts.createMany({
        data: data.hosts.map((h) => ({
          eventId: parseInt(eventId),
          userId: h.userId ? parseInt(h.userId) : null,
          discordUserId: h.discordUserId || null,
          displayName: h.displayName || null,
          role: h.role || "host",
        })),
      });
    }
  }

  await logEventAudit(
    parseInt(eventId),
    actorId,
    actorName,
    "updated",
    "Event details updated",
    { title: existing.title, status: existing.status },
    { title: updated.title, status: updated.status }
  );

  return updated;
}

/**
 * Submit a draft event for review.
 */
export async function submitForReview(eventId, actorId, actorName) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");

  // Conditional update so two concurrent submits (double-click, stale tab)
  // can't both pass the status check and both notify reviewers.
  const { count } = await prisma.events.updateMany({
    where: { eventId: parseInt(eventId), status: { in: ["draft", "rejected"] } },
    data: { status: "pending_review" },
  });

  if (count === 0) {
    const current = await getEventById(eventId);
    // Already submitted -- the caller's intent is satisfied, so not an error.
    if (current?.status === "pending_review") return { ...current, alreadySubmitted: true };
    throw new Error(`Cannot submit event in status '${current?.status ?? event.status}' for review`);
  }

  await logEventAudit(parseInt(eventId), actorId, actorName, "submitted_for_review", "Event submitted for review");

  return getEventById(eventId);
}

/**
 * Approve an event (admin action).
 */
/**
 * Refuse to approve or publish an event that has already started: its
 * announcements would all be in the past and Discord will not schedule it.
 */
function assertStartsInFuture(event, action) {
  const start = new Date(event.startAt);
  if (!Number.isNaN(start.getTime()) && start.getTime() <= Date.now()) {
    throw new Error(
      `Cannot ${action} an event whose start time has already passed. Change the date and time first.`
    );
  }
}

export async function approveEvent(eventId, reviewerId, reviewerName) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");
  if (event.status !== "pending_review") {
    throw new Error(`Cannot approve event in status '${event.status}'`);
  }
  // Checked before the status changes: approval publishes immediately, and a
  // publish refused after this point would strand the event as 'approved'.
  assertStartsInFuture(event, "approve");

  await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: {
      status: "approved",
      reviewerId,
      approvedAt: new Date(),
      rejectionNote: null,
    },
  });

  await logEventAudit(parseInt(eventId), reviewerId, reviewerName, "approved", "Event approved");

  // Immediately publish after approval
  return publishEvent(eventId, reviewerId, reviewerName);
}

/**
 * Revert a pending_review event back to draft (reviewer action).
 */
export async function revertToDraft(eventId, actorId, actorName) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");
  if (event.status !== "pending_review") {
    throw new Error(`Cannot revert event in status '${event.status}' to draft`);
  }

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: { status: "draft" },
  });

  await logEventAudit(
    parseInt(eventId),
    actorId,
    actorName,
    "reverted_to_draft",
    "Event reverted from review back to draft"
  );

  return updated;
}

/**
 * Reject an event (admin action).
 */
export async function rejectEvent(eventId, reviewerId, reviewerName, rejectionNote) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");
  if (event.status !== "pending_review") {
    throw new Error(`Cannot reject event in status '${event.status}'`);
  }

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: {
      status: "rejected",
      reviewerId,
      rejectionNote: rejectionNote || null,
    },
  });

  await logEventAudit(
    parseInt(eventId),
    reviewerId,
    reviewerName,
    "rejected",
    `Event rejected: ${rejectionNote || "No reason provided"}`
  );

  return updated;
}

/**
 * Revert an approved or pending-review event back to draft so the creator
 * can make further changes before resubmitting.
 */
export async function revertEventToDraft(eventId, reviewerId, reviewerName) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");
  if (!["pending_review", "approved"].includes(event.status)) {
    throw new Error(`Cannot revert event in status '${event.status}' to draft`);
  }

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: {
      status: "draft",
      reviewerId: null,
      rejectionNote: null,
    },
  });

  await logEventAudit(
    parseInt(eventId),
    reviewerId,
    reviewerName,
    "reverted_to_draft",
    `Event reverted to draft from '${event.status}'`
  );

  return updated;
}

/**
 * Publish an event (transitions approved → published).
 * Triggers downstream sync actions.
 */
export async function publishEvent(eventId, actorId, actorName) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");
  if (event.status !== "approved") {
    throw new Error(`Cannot publish event in status '${event.status}'`);
  }
  assertStartsInFuture(event, "publish");

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: { status: "published", publishedAt: new Date() },
  });

  await scheduleAnnouncementsForEvent(event.eventId);

  await logEventAudit(parseInt(eventId), actorId, actorName, "published", "Event published");

  return updated;
}

/**
 * Update a published event and mark it for downstream re-sync.
 */
export async function updatePublishedEvent(eventId, data, actorId, actorName) {
  const existing = await getEventById(eventId);
  if (!existing) throw new Error("Event not found");
  if (existing.status !== "published") {
    throw new Error(`Event is not published (status: ${existing.status})`);
  }

  const updated = await updateEvent(eventId, data, actorId, actorName);

  // Move announcements when either end of the event moves -- after_event
  // ones hang off the end time.
  if (data.startAt || data.endAt) {
    await recalculateAnnouncementSchedules(parseInt(eventId));
  }

  await logEventAudit(
    parseInt(eventId),
    actorId,
    actorName,
    "updated_published",
    "Published event updated — downstream sync required"
  );

  return updated;
}

/**
 * Cancel an event.
 */
export async function cancelEvent(eventId, actorId, actorName, reason = null) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");

  const allowed = ["draft", "pending_review", "approved", "published"];
  if (!allowed.includes(event.status)) {
    throw new Error(`Cannot cancel event in status '${event.status}'`);
  }

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: { status: "cancelled", cancelledAt: new Date() },
  });

  await stopEventAnnouncements(parseInt(eventId));

  await logEventAudit(
    parseInt(eventId),
    actorId,
    actorName,
    "cancelled",
    reason ? `Event cancelled: ${reason}` : "Event cancelled"
  );

  return updated;
}

/**
 * Soft-delete an event.
 */
export async function deleteEvent(eventId, actorId, actorName) {
  const event = await getEventById(eventId, true);
  if (!event) throw new Error("Event not found");

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: { deletedAt: new Date() },
  });

  await stopEventAnnouncements(parseInt(eventId));

  await logEventAudit(parseInt(eventId), actorId, actorName, "deleted", "Event soft-deleted");

  return updated;
}

/**
 * Archive an event.
 */
export async function archiveEvent(eventId, actorId, actorName) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: { status: "archived" },
  });

  await logEventAudit(parseInt(eventId), actorId, actorName, "archived", "Event archived");

  return updated;
}

/**
 * Update event sync status after Discord/website operations.
 */
export async function updateSyncStatus(eventId, platform, status, error = null, externalIds = {}) {
  const data = {};

  if (platform === "discord") {
    data.discordSyncStatus = status;
    data.discordSyncError = error || null;
    if (externalIds.discordMessageId !== undefined) data.discordMessageId = externalIds.discordMessageId;
    if (externalIds.discordGuildEventId !== undefined) data.discordGuildEventId = externalIds.discordGuildEventId;
    if (externalIds.discordChannelId !== undefined) data.discordChannelId = externalIds.discordChannelId;
  } else if (platform === "website") {
    data.websiteSyncStatus = status;
    data.websiteSyncError = error || null;
  }

  return prisma.events.update({ where: { eventId: parseInt(eventId) }, data });
}

/**
 * Upsert event actions (replace all actions for the event).
 */
export async function upsertEventActions(eventId, actions, actorId, actorName) {
  await prisma.event_actions.deleteMany({ where: { eventId: parseInt(eventId) } });

  if (Array.isArray(actions) && actions.length > 0) {
    await prisma.event_actions.createMany({
      data: actions.map((a) => ({
        eventId: parseInt(eventId),
        actionType: a.actionType,
        trigger: a.trigger || "on_publish",
        enabled: a.enabled !== undefined ? a.enabled : true,
        config: a.config || undefined,
      })),
    });
  }

  await logEventAudit(parseInt(eventId), actorId, actorName, "actions_updated", "Event actions updated");
}

/** Announcement fields as stored, from an editor/API payload. */
function announcementRowData(eventId, a) {
  return {
    eventId,
    label: a.label || null,
    announcementType: a.announcementType || "reminder",
    platform: a.platform || "discord",
    channelId: a.channelId || null,
    contentTemplate: a.contentTemplate || null,
    body: a.body || null,
    colourMessageFormat: a.colourMessageFormat || null,
    link: a.link || null,
    popupButtonText: a.popupButtonText || null,
    popupImageUrl: a.popupImageUrl || null,
    triggerType: a.triggerType || "before_event",
    offsetMinutes: parseOffsetMinutes(a.offsetMinutes),
    enabled: a.enabled !== undefined ? a.enabled : true,
    status: "pending",
  };
}

/**
 * Replace an event's announcements with the submitted list.
 *
 * Announcements already sent are history and cannot be edited: a submitted
 * row carrying a sent row's `id` keeps it unchanged, and a sent row left out
 * of the list is removed (switching off any site announcement it created).
 * Everything else -- pending, failed, cancelled -- is replaced by the
 * submitted rows, so saving again retries a failed one. Before this, every
 * save of a published event re-created its sent rows as new, never-sent
 * duplicates.
 *
 * On a published event the new rows are scheduled straight away; otherwise
 * that happens when it is published.
 */
export async function upsertEventAnnouncements(eventId, announcements, actorId, actorName) {
  const id = parseInt(eventId);
  const list = Array.isArray(announcements) ? announcements : [];

  const sent = await prisma.event_announcements.findMany({ where: { eventId: id, status: "sent" } });
  const keepIds = new Set(list.map((a) => parseInt(a.id, 10)).filter((n) => sent.some((s) => s.id === n)));
  const dropped = sent.filter((s) => !keepIds.has(s.id));

  const now = new Date();
  for (const s of dropped) {
    // Pre-cron Discord announcement still waiting in the old queue
    if (s.platform === "discord" && !s.sentAt && s.channelId && s.scheduledFor > now) {
      await prisma.scheduledDiscordMessages.updateMany({
        where: { channelId: s.channelId, scheduledFor: s.scheduledFor, status: "scheduled", sentAt: null },
        data: { status: "failed", lastError: "Removed from event" },
      });
    }
  }

  const droppedLinks = dropped.map((s) => s.linkedAnnouncementId).filter(Boolean);
  if (droppedLinks.length > 0) {
    await prisma.announcements.updateMany({
      where: { announcementId: { in: droppedLinks } },
      data: { enabled: false, updatedDate: new Date() },
    });
  }

  await prisma.event_announcements.deleteMany({
    where: {
      eventId: id,
      OR: [{ status: { not: "sent" } }, { id: { in: dropped.map((s) => s.id) } }],
    },
  });

  const created = [];
  for (const a of list) {
    if (keepIds.has(parseInt(a.id, 10))) continue;
    created.push(await prisma.event_announcements.create({ data: announcementRowData(id, a) }));
  }

  const event = await prisma.events.findUnique({ where: { eventId: id }, select: { status: true } });
  if (event?.status === "published" && created.length > 0) {
    await scheduleAnnouncementsForEvent(id, created.map((c) => c.id));
  }

  await logEventAudit(id, actorId, actorName, "announcements_updated", "Event announcements updated");
}

/**
 * Schedule a published event's pending announcements.
 *
 * Discord announcements stay pending with a send time; the event announcement
 * cron (cron/eventAnnouncementCron.js) sends them when due, using the event's
 * details at that moment and skipping it if the event is no longer published.
 * Site announcements (MOTD, tip, web, popup) are created now with a display
 * window, and linked so a later cancel or reschedule can reach them.
 *
 * `onlyIds` limits it to those rows (ones added after publishing).
 */
async function scheduleAnnouncementsForEvent(eventId, onlyIds = null) {
  const event = await prisma.events.findUnique({ where: { eventId } });
  if (!event) return;

  const announcements = await prisma.event_announcements.findMany({
    where: { eventId, enabled: true, status: "pending", ...(onlyIds ? { id: { in: onlyIds } } : {}) },
  });

  for (const ann of announcements) {
    const platform = ann.platform || "discord";

    if (platform === "discord") {
      if (!ann.channelId) {
        await prisma.event_announcements.update({
          where: { id: ann.id },
          data: { status: "failed", lastError: "No channel selected" },
        });
        continue;
      }
      const scheduledFor = discordScheduledFor(ann, event.startAt, event.endAt);
      if (!scheduledFor) continue;
      await prisma.event_announcements.update({ where: { id: ann.id }, data: { scheduledFor } });
    } else if (SITE_ANNOUNCEMENT_PLATFORMS.includes(platform)) {
      const now = new Date();
      const site = await prisma.announcements.create({
        data: {
          enabled: true,
          announcementType: platform,
          body: ann.body || null,
          colourMessageFormat: ann.colourMessageFormat || null,
          link: ann.link || null,
          popupButtonText: ann.popupButtonText || null,
          popupImageUrl: ann.popupImageUrl || null,
          ...siteAnnouncementWindow(ann, event.startAt, event.endAt),
          createdAt: now,
          updatedDate: now,
        },
      });

      await prisma.event_announcements.update({
        where: { id: ann.id },
        data: { status: "sent", sentAt: now, linkedAnnouncementId: site.announcementId },
      });
    }
  }
}

/** Statuses whose events can still take new announcements. */
const DEFAULTS_APPLY_STATUSES = ["draft", "pending_review", "approved", "rejected", "published"];

/**
 * Add the site-wide default announcements to every upcoming event that does
 * not already have them. On published events the added ones are queued
 * straight away (they would otherwise never send); see missingDefaults() for
 * which defaults a published event skips.
 *
 * With `dryRun` nothing is written; the counts say what would happen.
 * Returns { events, announcements, publishedEvents }.
 */
export async function applyDefaultAnnouncementsToEvents(defaults, { dryRun = false, actorId = null, actorName = "System" } = {}) {
  const now = new Date();
  const events = await prisma.events.findMany({
    where: { deletedAt: null, status: { in: DEFAULTS_APPLY_STATUSES }, startAt: { gt: now } },
    select: {
      eventId: true,
      status: true,
      startAt: true,
      endAt: true,
      announcements: { where: { status: { not: "cancelled" } } },
    },
  });

  const result = { events: 0, announcements: 0, publishedEvents: 0 };

  for (const event of events) {
    const published = event.status === "published";
    const toAdd = missingDefaults(event.announcements, defaults, {
      published,
      startAt: event.startAt,
      endAt: event.endAt,
      now,
    });
    if (toAdd.length === 0) continue;

    result.events++;
    result.announcements += toAdd.length;
    if (published) result.publishedEvents++;
    if (dryRun) continue;

    const created = [];
    for (const a of toAdd) {
      created.push(
        await prisma.event_announcements.create({ data: announcementRowData(event.eventId, a) })
      );
    }

    if (published) {
      await scheduleAnnouncementsForEvent(event.eventId, created.map((c) => c.id));
    }

    await logEventAudit(
      event.eventId,
      actorId,
      actorName,
      "announcements_updated",
      `Added ${toAdd.length} default announcement${toAdd.length === 1 ? "" : "s"}`
    );
  }

  return result;
}

/**
 * Get events pending review (for admin queue).
 */
export async function getPendingReviewEvents() {
  return prisma.events.findMany({
    where: { status: "pending_review", deletedAt: null },
    include: { hosts: true },
    orderBy: { updatedAt: "asc" },
  });
}

/**
 * Duplicate an event into a new draft.
 */
export async function duplicateEvent(eventId, actorId, actorName) {
  const source = await getEventById(eventId);
  if (!source) throw new Error("Event not found");

  const newStartAt = source.startAt;
  const slug = await generateSlug(`${source.title}-copy`, newStartAt);

  const newEvent = await prisma.events.create({
    data: {
      title: `${source.title} (Copy)`,
      slug,
      description: source.description,
      teaserDescription: source.teaserDescription,
      eventType: source.eventType,
      startAt: source.startAt,
      endAt: source.endAt,
      timezone: source.timezone,
      status: "draft",
      visibility: source.visibility,
      teaserPublic: source.teaserPublic,
      locationLabel: source.locationLabel,
      serverName: source.serverName,
      serverIp: source.serverIp,
      externalLinks: source.externalLinks || undefined,
      bannerUrl: source.bannerUrl,
      logoUrl: source.logoUrl,
      tags: source.tags || undefined,
      featured: false,
      creatorId: actorId,
      templateId: source.templateId,
    },
  });

  // Copy the rank lock — a duplicated supporter event that silently went
  // public would leak the original.
  if (source.rankAccess?.length > 0) {
    await syncRankAccess(newEvent.eventId, source.rankAccess);
  }

  // Copy hosts
  if (source.hosts.length > 0) {
    await prisma.event_hosts.createMany({
      data: source.hosts.map((h) => ({
        eventId: newEvent.eventId,
        userId: h.userId ? parseInt(h.userId) : null,
        discordUserId: h.discordUserId,
        displayName: h.displayName,
        role: h.role,
      })),
    });
  }

  // Copy actions (reset run state)
  if (source.actions.length > 0) {
    await prisma.event_actions.createMany({
      data: source.actions.map((a) => ({
        eventId: newEvent.eventId,
        actionType: a.actionType,
        trigger: a.trigger,
        enabled: a.enabled,
        config: a.config || undefined,
      })),
    });
  }

  // Copy announcements as fresh, unsent ones (dropping cancelled leftovers)
  const announcements = (source.announcements || []).filter((a) => a.status !== "cancelled");
  if (announcements.length > 0) {
    await prisma.event_announcements.createMany({
      data: announcements.map((a) => announcementRowData(newEvent.eventId, a)),
    });
  }

  await logEventAudit(newEvent.eventId, actorId, actorName, "created", `Duplicated from event #${eventId}`);

  return newEvent;
}
