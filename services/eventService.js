/**
 * Event Service
 * Core CRUD operations and lifecycle management for the Events Calendar module.
 */

import { prisma } from "../controllers/databaseController.js";

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
 * Recalculate scheduled announcement times for an event.
 * Called whenever event start time changes.
 */
async function recalculateAnnouncementSchedules(eventId, startAt) {
  const event = await prisma.events.findUnique({ where: { eventId } });
  const announcements = await prisma.event_announcements.findMany({
    where: { eventId, status: "pending", enabled: true },
  });

  for (const ann of announcements) {
    let scheduledFor = null;

    if (ann.triggerType === "before_event" && ann.offsetMinutes != null) {
      scheduledFor = new Date(new Date(startAt).getTime() - ann.offsetMinutes * 60000);
    } else if (ann.triggerType === "event_start") {
      scheduledFor = new Date(startAt);
    } else if (ann.triggerType === "after_event" && event?.endAt) {
      const offset = (ann.offsetMinutes || 0) * 60000;
      scheduledFor = new Date(new Date(event.endAt).getTime() + offset);
    }

    if (scheduledFor) {
      await prisma.event_announcements.update({
        where: { id: ann.id },
        data: { scheduledFor },
      });
    }
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
    include: { hosts: true },
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
    },
  });

  if (!event) return null;
  if (!includeDeleted && event.deletedAt) return null;

  return event;
}

/**
 * Get a single published event by slug (public-facing).
 */
export async function getPublishedEventBySlug(slug) {
  return prisma.events.findFirst({
    where: { slug, status: "published", deletedAt: null, visibility: "public" },
    include: { hosts: true },
  });
}

/**
 * Get upcoming published events for the public listing.
 */
export async function getUpcomingPublishedEvents(limit = 20) {
  return prisma.events.findMany({
    where: {
      status: "published",
      deletedAt: null,
      visibility: "public",
      endAt: { gte: new Date() },
    },
    include: { hosts: true },
    orderBy: { startAt: "asc" },
    take: limit,
  });
}

/**
 * Get all published events for listing (past + upcoming).
 */
export async function getAllPublishedEvents(page = 1, limit = 20) {
  const where = { status: "published", deletedAt: null, visibility: "public" };
  const [total, events] = await Promise.all([
    prisma.events.count({ where }),
    prisma.events.findMany({
      where,
      include: { hosts: true },
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
      description: data.description || null,
      eventType: data.eventType || "once",
      startAt: new Date(data.startAt),
      endAt: new Date(data.endAt),
      timezone: data.timezone || "UTC",
      status: "draft",
      visibility: data.visibility || "public",
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
      templateId: data.templateId || null,
    },
  });

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
  if (data.description !== undefined) updateData.description = data.description;
  if (data.eventType !== undefined) updateData.eventType = data.eventType;
  if (data.startAt !== undefined) updateData.startAt = new Date(data.startAt);
  if (data.endAt !== undefined) updateData.endAt = new Date(data.endAt);
  if (data.timezone !== undefined) updateData.timezone = data.timezone;
  if (data.visibility !== undefined) updateData.visibility = data.visibility;
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

  // Recalculate announcement schedules if time changed
  if (data.startAt && existing.status !== "published") {
    await recalculateAnnouncementSchedules(parseInt(eventId), data.startAt);
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
  if (event.status !== "draft" && event.status !== "rejected") {
    throw new Error(`Cannot submit event in status '${event.status}' for review`);
  }

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: { status: "pending_review" },
  });

  await logEventAudit(parseInt(eventId), actorId, actorName, "submitted_for_review", "Event submitted for review");

  return updated;
}

/**
 * Approve an event (admin action).
 */
export async function approveEvent(eventId, reviewerId, reviewerName) {
  const event = await getEventById(eventId);
  if (!event) throw new Error("Event not found");
  if (event.status !== "pending_review") {
    throw new Error(`Cannot approve event in status '${event.status}'`);
  }

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

  const updated = await prisma.events.update({
    where: { eventId: parseInt(eventId) },
    data: { status: "published", publishedAt: new Date() },
  });

  // Schedule enabled announcements through the central scheduler
  await scheduleAnnouncementsForEvent(event.eventId, event.startAt, actorId);

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

  // Recalculate announcement schedules after time change
  if (data.startAt) {
    await recalculateAnnouncementSchedules(parseInt(eventId), data.startAt);
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

  // Cancel pending announcements
  await prisma.event_announcements.updateMany({
    where: { eventId: parseInt(eventId), status: "pending" },
    data: { status: "cancelled" },
  });

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

/**
 * Upsert event announcements (replace all for the event).
 */
export async function upsertEventAnnouncements(eventId, announcements, actorId, actorName) {
  await prisma.event_announcements.deleteMany({
    where: { eventId: parseInt(eventId), status: "pending" },
  });

  if (Array.isArray(announcements) && announcements.length > 0) {
    await prisma.event_announcements.createMany({
      data: announcements.map((a) => ({
        eventId: parseInt(eventId),
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
        offsetMinutes: a.offsetMinutes || null,
        enabled: a.enabled !== undefined ? a.enabled : true,
        status: "pending",
      })),
    });
  }

  await logEventAudit(parseInt(eventId), actorId, actorName, "announcements_updated", "Event announcements updated");
}

/**
 * Schedule announcements for a published event.
 * Creates scheduledDiscordMessages entries so the central schedulerCron handles delivery.
 */
async function scheduleAnnouncementsForEvent(eventId, startAt, actorId) {
  const event = await prisma.events.findUnique({ where: { eventId } });
  const announcements = await prisma.event_announcements.findMany({
    where: { eventId, enabled: true, status: "pending" },
  });

  for (const ann of announcements) {
    let scheduledFor = null;

    if (ann.triggerType === "on_publish") {
      scheduledFor = new Date();
    } else if (ann.triggerType === "before_event" && ann.offsetMinutes != null) {
      scheduledFor = new Date(new Date(startAt).getTime() - ann.offsetMinutes * 60000);
    } else if (ann.triggerType === "event_start") {
      scheduledFor = new Date(startAt);
    } else if (ann.triggerType === "after_event" && event?.endAt) {
      const offset = (ann.offsetMinutes || 0) * 60000;
      scheduledFor = new Date(new Date(event.endAt).getTime() + offset);
    }

    if (!scheduledFor) continue;

    // Skip if the scheduled time is already in the past
    if (scheduledFor < new Date()) {
      scheduledFor = new Date(); // send immediately
    }

    const platform = ann.platform || "discord";

    if (platform === "discord") {
      if (!ann.channelId) continue;

      // Build embed description
      let description = ann.contentTemplate || null;
      if (!description && event) {
        const ts = Math.floor(new Date(startAt).getTime() / 1000);
        if (ann.triggerType === "on_publish") {
          description = `A new event has been announced: **${event.title}**\n\n<t:${ts}:F> (<t:${ts}:R>)`;
        } else if (ann.triggerType === "before_event") {
          description = `**${event.title}** starts in ${ann.offsetMinutes} minutes! (<t:${ts}:R>)`;
        } else if (ann.triggerType === "event_start") {
          description = `**${event.title}** is starting now!`;
        } else if (ann.triggerType === "after_event") {
          description = `**${event.title}** has ended. Thanks for participating!`;
        } else {
          description = `Reminder: **${event.title}** — <t:${ts}:F>`;
        }
      }

      // Replace template variables
      if (description && event) {
        const ts = Math.floor(new Date(startAt).getTime() / 1000);
        description = description
          .replace(/\{title\}/g, event.title)
          .replace(/\{location\}/g, event.locationLabel || "TBA")
          .replace(/\{startAt\}/g, `<t:${ts}:F>`)
          .replace(/\{startRelative\}/g, `<t:${ts}:R>`);
      }

      await prisma.scheduledDiscordMessages.create({
        data: {
          channelId: ann.channelId,
          embedTitle: event?.title || ann.label || "Event Announcement",
          embedDescription: description,
          embedColor: "#2f508c",
          scheduledFor,
          createdBy: actorId || 0,
          status: "scheduled",
        },
      });

      await prisma.event_announcements.update({
        where: { id: ann.id },
        data: { scheduledFor, status: "sent" },
      });
    } else {
      // Non-Discord platforms (motd, tip, web, popup) → create announcements record
      const validTypes = ["motd", "tip", "web", "popup"];
      if (!validTypes.includes(platform)) continue;

      // Compute startDate / endDate based on trigger
      let annStartDate = null;
      let annEndDate = null;

      if (ann.triggerType === "on_publish") {
        annStartDate = null; // always active
        annEndDate = event?.endAt ? new Date(event.endAt) : null;
      } else if (ann.triggerType === "before_event" && ann.offsetMinutes != null) {
        annStartDate = new Date(new Date(startAt).getTime() - ann.offsetMinutes * 60000);
        annEndDate = new Date(startAt);
      } else if (ann.triggerType === "event_start") {
        annStartDate = new Date(startAt);
        annEndDate = event?.endAt ? new Date(event.endAt) : null;
      } else if (ann.triggerType === "after_event" && event?.endAt) {
        const offset = (ann.offsetMinutes || 0) * 60000;
        annStartDate = new Date(new Date(event.endAt).getTime() + offset);
        annEndDate = null;
      }

      await prisma.announcements.create({
        data: {
          enabled: true,
          announcementType: platform,
          body: ann.body || null,
          colourMessageFormat: ann.colourMessageFormat || null,
          link: ann.link || null,
          popupButtonText: ann.popupButtonText || null,
          popupImageUrl: ann.popupImageUrl || null,
          startDate: annStartDate,
          endDate: annEndDate,
          updatedDate: new Date(),
        },
      });

      await prisma.event_announcements.update({
        where: { id: ann.id },
        data: { scheduledFor, status: "sent" },
      });
    }
  }
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
      eventType: source.eventType,
      startAt: source.startAt,
      endAt: source.endAt,
      timezone: source.timezone,
      status: "draft",
      visibility: source.visibility,
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

  await logEventAudit(newEvent.eventId, actorId, actorName, "created", `Duplicated from event #${eventId}`);

  return newEvent;
}
