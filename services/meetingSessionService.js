/**
 * Meeting Session Service
 *
 * Phase two of the Meetings module: the meeting itself, as opposed to phase
 * one's polls (services/meetingPollService.js), which only decide when to hold
 * it.  Agenda, recording, timestamped discussion, minutes with visibility and
 * timed reveal, catch-up tracking and archival.
 *
 * Nothing in here is specific to any one meeting.  The same code serves a
 * monthly cross-timezone staff meeting, an ad-hoc call with no poll behind it
 * and a one-off; no name, cadence or roster is hardcoded anywhere.
 *
 * ANCHOR RULE, repeated because everything below depends on it: every
 * `*OffsetMs` is milliseconds from `meetingSessions`.`startedAt`, never from
 * the start of an audio file.  A session can hold several recordings, each at
 * its own `startOffsetMs` on that one timeline.
 *
 * Prisma Client, not raw SQL, matching meetingPollService.js.
 */

import { prisma } from "../controllers/databaseController.js";
import { generateSlug } from "./eventService.js";
import {
  classifyInviteeEligibility,
  expandRanksToInvitees,
} from "./meetingRosterService.js";
import {
  ARCHIVE_STATUS,
  audioRemovalBlockedReason,
  canConfirmArchive,
  canRemoveAudio,
  planArchiveRequest,
} from "../lib/meetings/archiveState.mjs";
import {
  ATTENDEE_ROLE,
  ATTENDEE_ROLE_VALUES,
  REVEAL_MODE,
  REVEAL_MODE_VALUES,
  VISIBILITY,
  VISIBILITY_VALUES,
  buildViewer,
  revealWhere,
  selectVisibleAgendaItems,
  selectVisibleComments,
  selectVisibleNotes,
  visibilityWhere,
} from "../lib/meetings/visibility.mjs";
import {
  coverageGaps,
  locateOffset,
  normaliseRecordings,
  planAgendaAdvance,
  recordedCoverageMs,
  recordedSpanMs,
} from "../lib/meetings/timeline.mjs";

export const SESSION_STATUS = {
  DRAFT: "draft",
  LIVE: "live",
  /** Recording stopped, mixdown/upload still running. */
  PROCESSING: "processing",
  PUBLISHED: "published",
  CLOSED: "closed",
  CANCELLED: "cancelled",
};

export const SESSION_AUDIENCE_MODE = {
  ROSTER: "roster",
  OPEN: "open",
};

export const AGENDA_ITEM_STATUS = {
  PENDING: "pending",
  DISCUSSED: "discussed",
  DEFERRED: "deferred",
  DECIDED: "decided",
};

export const NOTE_KIND = {
  NOTE: "note",
  DECISION: "decision",
  ACTION: "action",
};

export const COMMENT_KIND = {
  TEXT: "text",
  VOICE: "voice",
};

export const TRANSCRIPT_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped",
};

export const RECORDING_SOURCE = {
  DISCORD_BOT: "discord_bot",
  UPLOAD: "upload",
  EXTERNAL: "external",
};

export { ARCHIVE_STATUS, ATTENDEE_ROLE, REVEAL_MODE, VISIBILITY };

const SESSION_STATUS_VALUES = Object.values(SESSION_STATUS);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Prisma hands BIGINT columns back as BigInt, which JSON.stringify throws on.
 * Every offset and byte size in this module goes through here on the way out,
 * rather than being patched up at each of the several dozen render sites.
 */
function num(value) {
  return value == null ? null : Number(value);
}

function intOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseInt(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function offsetOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function trimOrNull(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

/**
 * Where the meeting is, right now, on its own timeline.
 *
 * Wall clock against `startedAt` rather than anything derived from the audio:
 * the agenda has to keep being stampable while the bot is disconnected, and the
 * recording that eventually arrives has to line up with those stamps.
 */
export function currentOffsetMs(session, now = new Date()) {
  if (!session?.startedAt) return null;
  return Math.max(0, now.getTime() - new Date(session.startedAt).getTime());
}

/** Resolve the viewer's role on a session, for the visibility helpers. */
export async function getViewerContext(sessionId, { userId = null, isManager = false } = {}) {
  const uid = intOrNull(userId);

  const attendee = uid
    ? await prisma.meetingSessionAttendees.findUnique({
        where: { sessionId_userId: { sessionId: parseInt(sessionId), userId: uid } },
      })
    : null;

  return buildViewer({ userId: uid, isManager, attendee });
}

/**
 * Whether this viewer may open the session at all.
 *
 * `roster` sessions are attendees-only; `open` ones are readable by any
 * logged-in user, which is what makes a session usable as a record the whole
 * team can catch up on without everybody being on the roster.
 */
export function canViewSession(session, viewer) {
  if (!session) return false;
  if (viewer?.isManager) return true;
  if (session.audienceMode === SESSION_AUDIENCE_MODE.OPEN) return viewer?.userId != null;
  return Boolean(viewer?.isAttendee);
}

function assertSessionEditable(session) {
  if (!session) throw new Error("Meeting session not found.");
  if (session.status === SESSION_STATUS.CANCELLED) {
    throw new Error("This meeting session has been cancelled.");
  }
}

// ============================================================================
// Reads
// ============================================================================

/**
 * List sessions for the dashboard.
 *
 * `attendeeUserId` restricts the list to sessions that user is actually on,
 * which is how a non-manager sees only their own meetings — the same scoping
 * rule as getPolls() in phase one.
 */
export async function getSessions({
  status = null,
  statuses = null,
  search = null,
  attendeeUserId = null,
  page = 1,
  limit = 50,
} = {}) {
  const where = {};

  if (statuses && statuses.length > 0) where.status = { in: statuses };
  else if (status) where.status = status;

  if (search) where.event = { title: { contains: search } };

  if (attendeeUserId) {
    // An `open` session is listed for everyone, because anyone may open it.
    where.OR = [
      { attendees: { some: { userId: parseInt(attendeeUserId), removedAt: null } } },
      { audienceMode: SESSION_AUDIENCE_MODE.OPEN },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.meetingSessions.count({ where }),
    prisma.meetingSessions.findMany({
      where,
      include: {
        event: { select: { eventId: true, title: true, slug: true, startAt: true, endAt: true, timezone: true } },
        _count: {
          select: {
            attendees: { where: { removedAt: null } },
            comments: { where: { deletedAt: null } },
            recordings: true,
          },
        },
      },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const sessions = rows.map((row) => ({
    ...row,
    durationMs: num(row.durationMs),
    archiveByteSize: num(row.archiveByteSize),
  }));

  return { total, sessions, page, limit };
}

/** The bare session row, with its event.  No visibility filtering applied. */
export async function getSession(sessionId) {
  return prisma.meetingSessions.findUnique({
    where: { sessionId: parseInt(sessionId) },
    include: { event: true },
  });
}

export async function getSessionByEventId(eventId) {
  return prisma.meetingSessions.findUnique({
    where: { eventId: parseInt(eventId) },
    include: { event: true },
  });
}

/**
 * Everything the player needs, already filtered for this viewer.
 *
 * Visibility and reveal are applied *here*, in the query path — never in the
 * template.  Hidden rows are dropped, not flagged: a note the viewer may not
 * read has no `body` anywhere in the returned payload, so no amount of reading
 * the page source or the JSON recovers it.
 *
 * `playbackOffsetMs` is whatever the client last reported.  That is a request,
 * not proof, so `on_playback` reveal is a reading-ahead deterrent only —
 * anything genuinely sensitive belongs behind `scheduled` or manual release.
 */
export async function getSessionForViewer(
  sessionId,
  { userId = null, isManager = false, playbackOffsetMs = null, now = new Date() } = {}
) {
  const id = parseInt(sessionId);

  const session = await prisma.meetingSessions.findUnique({
    where: { sessionId: id },
    include: { event: true },
  });
  if (!session) return null;

  const viewer = await getViewerContext(id, { userId, isManager });
  if (!canViewSession(session, viewer)) return { forbidden: true, viewer };

  // Where the viewer has played to.  Read from the stored progress row unless
  // the caller passed a fresher position, so a page load reveals what the
  // viewer had already reached last time rather than resetting them to zero.
  const progress = viewer.userId
    ? await prisma.meetingSessionProgress.findUnique({
        where: { sessionId_userId: { sessionId: id, userId: viewer.userId } },
      })
    : null;

  const effectivePlayback =
    playbackOffsetMs != null ? offsetOrNull(playbackOffsetMs) : num(progress?.lastOffsetMs) || 0;

  const [agendaItemsRaw, recordingsRaw, notesRaw, commentsRaw, attendeesRaw] = await Promise.all([
    prisma.meetingAgendaItems.findMany({
      where: { sessionId: id },
      orderBy: { orderIndex: "asc" },
    }),
    prisma.meetingRecordings.findMany({
      where: { sessionId: id },
      orderBy: { startOffsetMs: "asc" },
    }),
    // Visibility and the SQL-decidable half of reveal are applied in the query.
    prisma.meetingNotes.findMany({
      where: {
        sessionId: id,
        deletedAt: null,
        AND: [visibilityWhere(viewer, { authorField: "authorUserId" }), revealWhere(viewer, now)],
      },
      orderBy: [{ orderIndex: "asc" }, { noteId: "asc" }],
    }),
    prisma.meetingComments.findMany({
      where: {
        sessionId: id,
        deletedAt: null,
        ...visibilityWhere(viewer, { authorField: "userId" }),
      },
      orderBy: [{ atOffsetMs: "asc" }, { createdAt: "asc" }],
    }),
    prisma.meetingSessionAttendees.findMany({ where: { sessionId: id, removedAt: null } }),
  ]);

  const agendaItems = selectVisibleAgendaItems(agendaItemsRaw, { viewer }).map((item) => ({
    ...item,
    startOffsetMs: num(item.startOffsetMs),
    endOffsetMs: num(item.endOffsetMs),
  }));

  // The fallback map for on_playback reveal is built from the *unfiltered*
  // agenda, so a note on an item the viewer cannot see still resolves its
  // reveal point correctly rather than silently falling back to 0.
  const agendaItemById = new Map(agendaItemsRaw.map((item) => [item.itemId, item]));

  const notes = selectVisibleNotes(notesRaw, {
    viewer,
    agendaItemById,
    playbackOffsetMs: effectivePlayback,
    now,
  }).map((note) => ({
    ...note,
    revealAtOffsetMs: num(note.revealAtOffsetMs),
  }));

  const comments = selectVisibleComments(commentsRaw, { viewer }).map((comment) => ({
    ...comment,
    atOffsetMs: num(comment.atOffsetMs),
    audioDurationMs: num(comment.audioDurationMs),
  }));

  // Joined by recordingId rather than by array position: normaliseRecordings
  // sorts its output, so the two arrays line up only by coincidence and a
  // reordering would silently attach one recording's transcript state to
  // another's audio.
  const recordingRowById = new Map(recordingsRaw.map((row) => [row.recordingId, row]));
  const recordings = normaliseRecordings(recordingsRaw).map((recording) => ({
    ...recording,
    mimeType: recordingRowById.get(recording.recordingId)?.mimeType ?? null,
    transcriptStatus: recordingRowById.get(recording.recordingId)?.transcriptStatus ?? null,
  }));

  // Usernames for every id that appears, fetched once rather than per row.
  const userIds = [
    ...new Set([
      ...attendeesRaw.map((a) => a.userId),
      ...comments.map((c) => c.userId),
      ...notes.map((n) => n.authorUserId),
    ]),
  ];
  const users = userIds.length
    ? await prisma.users.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, username: true, uuid: true },
      })
    : [];
  const userById = new Map(users.map((user) => [user.userId, user]));
  const nameFor = (id) => userById.get(id)?.username || `User #${id}`;

  const attendees = attendeesRaw
    .map((attendee) => ({ ...attendee, username: userById.get(attendee.userId)?.username || null }))
    .sort((a, b) => (a.username || "").localeCompare(b.username || ""));

  const durationMs = num(session.durationMs) ?? recordedSpanMs(recordings);

  return {
    ...session,
    durationMs,
    archiveByteSize: num(session.archiveByteSize),
    viewer,
    agendaItems,
    recordings,
    notes: notes.map((note) => ({ ...note, authorName: nameFor(note.authorUserId) })),
    comments: comments.map((comment) => ({ ...comment, username: nameFor(comment.userId) })),
    attendees: viewer.isManager || viewer.isChair ? attendees : [],
    attendeeCount: attendeesRaw.length,
    // Audio coverage, so the player can tell a viewer who scrubs into a gap
    // that the bot was disconnected rather than leaving them staring at silence.
    audioSpanMs: recordedSpanMs(recordings),
    audioCoverageMs: recordedCoverageMs(recordings),
    coverageGaps: coverageGaps(recordings, durationMs),
    viewerProgress: progress
      ? { lastOffsetMs: num(progress.lastOffsetMs), completedAt: progress.completedAt, respondedAt: progress.respondedAt }
      : { lastOffsetMs: 0, completedAt: null, respondedAt: null },
    liveOffsetMs: session.status === SESSION_STATUS.LIVE ? currentOffsetMs(session, now) : null,
  };
}

/** Which recording holds a given point on the session timeline. */
export async function resolveOffset(sessionId, offsetMs) {
  const recordings = await prisma.meetingRecordings.findMany({
    where: { sessionId: parseInt(sessionId) },
  });
  return locateOffset(recordings, offsetMs);
}

// ============================================================================
// Session lifecycle
// ============================================================================

/**
 * Create the session hanging off an event.
 *
 * The roster is seeded immediately — from the poll when the event came from one,
 * otherwise from the ranks the caller names — so the organiser has something to
 * look at before the meeting rather than an empty list.
 */
export async function createSession(data, actorId) {
  const eventId = intOrNull(data?.eventId);
  if (!eventId) throw new Error("An event is required to create a meeting session.");

  const event = await prisma.events.findUnique({ where: { eventId } });
  if (!event) throw new Error("Event not found.");

  const existing = await prisma.meetingSessions.findUnique({ where: { eventId } });
  if (existing) throw new Error("This event already has a meeting session.");

  const session = await prisma.meetingSessions.create({
    data: {
      eventId,
      status: oneOf(data?.status, SESSION_STATUS_VALUES, SESSION_STATUS.DRAFT),
      audienceMode: oneOf(
        data?.audienceMode,
        Object.values(SESSION_AUDIENCE_MODE),
        SESSION_AUDIENCE_MODE.ROSTER
      ),
      responseDeadlineAt: data?.responseDeadlineAt ? new Date(data.responseDeadlineAt) : null,
      summary: trimOrNull(data?.summary),
      noteRevealMode: oneOf(data?.noteRevealMode, REVEAL_MODE_VALUES, REVEAL_MODE.IMMEDIATE),
      createdByUserId: actorId,
    },
  });

  if (Array.isArray(data?.agendaItems) && data.agendaItems.length > 0) {
    await prisma.meetingAgendaItems.createMany({
      data: data.agendaItems.map((item, index) => ({
        sessionId: session.sessionId,
        title: trimOrNull(item.title, 255) || `Item ${index + 1}`,
        brief: trimOrNull(item.brief),
        orderIndex: Number.isInteger(item.orderIndex) ? item.orderIndex : index,
        hiddenUntilReached: Boolean(item.hiddenUntilReached),
      })),
    });
  }

  await refreshAttendees(session.sessionId, { rankSlugs: data?.rankSlugs || null });

  // Whoever created the session chairs it until told otherwise — a session with
  // no chair has nobody who can see the full agenda or stamp it.
  if (actorId) {
    await prisma.meetingSessionAttendees.upsert({
      where: { sessionId_userId: { sessionId: session.sessionId, userId: actorId } },
      create: {
        sessionId: session.sessionId,
        userId: actorId,
        source: "manual",
        role: ATTENDEE_ROLE.CHAIR,
      },
      update: { role: ATTENDEE_ROLE.CHAIR, removedAt: null },
    });
  }

  return getSession(session.sessionId);
}

/**
 * Update the organiser-editable fields.
 *
 * `startedAt` is deliberately absent and can never be set through here: it is
 * the origin of every offset in the module, so moving it would silently
 * invalidate every agenda stamp, comment position and note reveal already
 * recorded.  startSession() writes it exactly once.
 */
export async function updateSession(sessionId, data, _actorId) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  assertSessionEditable(session);

  const updateData = {};

  if (data.status !== undefined) {
    updateData.status = oneOf(data.status, SESSION_STATUS_VALUES, session.status);
  }
  if (data.audienceMode !== undefined) {
    updateData.audienceMode = oneOf(
      data.audienceMode,
      Object.values(SESSION_AUDIENCE_MODE),
      session.audienceMode
    );
  }
  if (data.responseDeadlineAt !== undefined) {
    updateData.responseDeadlineAt = data.responseDeadlineAt ? new Date(data.responseDeadlineAt) : null;
  }
  if (data.summary !== undefined) updateData.summary = trimOrNull(data.summary);
  if (data.noteRevealMode !== undefined) {
    updateData.noteRevealMode = oneOf(data.noteRevealMode, REVEAL_MODE_VALUES, session.noteRevealMode);
  }

  await prisma.meetingSessions.update({ where: { sessionId: id }, data: updateData });
  return getSession(id);
}

/**
 * Begin capture.  Writes `startedAt` once and only once.
 *
 * A re-start — the bot rejoining after a drop, or a second `/meeting start` —
 * must NOT move the origin, or every offset recorded so far shifts underneath
 * the agenda.  The existing `startedAt` is returned instead, and the recorder
 * uses it to compute the `startOffsetMs` of its second recording.
 *
 * Keyed on eventId rather than sessionId because the Discord side knows which
 * meeting it is running, not which row id it has.
 */
export async function startSession({ eventId, sessionId = null, actorId = null }) {
  const session = sessionId
    ? await prisma.meetingSessions.findUnique({ where: { sessionId: parseInt(sessionId) } })
    : await prisma.meetingSessions.findUnique({ where: { eventId: parseInt(eventId) } });

  if (!session) throw new Error("Meeting session not found.");
  if (session.status === SESSION_STATUS.CANCELLED) {
    throw new Error("This meeting session has been cancelled.");
  }

  const alreadyStarted = Boolean(session.startedAt);

  const updated = await prisma.meetingSessions.update({
    where: { sessionId: session.sessionId },
    data: {
      status: SESSION_STATUS.LIVE,
      ...(alreadyStarted ? {} : { startedAt: new Date() }),
    },
  });

  if (actorId) {
    await prisma.meetingSessionAttendees.updateMany({
      where: { sessionId: session.sessionId, userId: actorId },
      data: { attendedLive: true },
    });
  }

  return { session: updated, resumed: alreadyStarted };
}

/**
 * Stop the meeting.
 *
 * Moves to `processing`, not `published`: the mixdown and upload are still
 * running, and a session shown as published with no audio reads as lost rather
 * than pending.  publishSession() completes the move once the audio lands.
 *
 * `durationMs` is the authoritative meeting length and is not derived from the
 * recordings, because a meeting keeps running after the bot disconnects.
 */
export async function endSession({ sessionId, durationMs = null, now = new Date() }) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  if (!session) throw new Error("Meeting session not found.");

  const measured = durationMs != null ? offsetOrNull(durationMs) : currentOffsetMs(session, now);

  // Close whatever agenda item was still open, so the last chapter has an end.
  const openItem = await prisma.meetingAgendaItems.findFirst({
    where: { sessionId: id, startOffsetMs: { not: null }, endOffsetMs: null },
    orderBy: { orderIndex: "desc" },
  });
  if (openItem && measured != null) {
    await prisma.meetingAgendaItems.update({
      where: { itemId: openItem.itemId },
      data: {
        endOffsetMs: Math.max(measured, Number(openItem.startOffsetMs)),
        status: AGENDA_ITEM_STATUS.DISCUSSED,
      },
    });
  }

  return prisma.meetingSessions.update({
    where: { sessionId: id },
    data: { status: SESSION_STATUS.PROCESSING, endedAt: now, durationMs: measured },
  });
}

/**
 * Make the session readable to its audience and start the response clock.
 * Called once the audio is in place — by hand, or by the recorder after upload.
 */
export async function publishSession(sessionId, { responseDeadlineAt = undefined } = {}) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  if (!session) throw new Error("Meeting session not found.");
  if (session.status === SESSION_STATUS.CANCELLED) {
    throw new Error("A cancelled meeting session cannot be published.");
  }

  return prisma.meetingSessions.update({
    where: { sessionId: id },
    data: {
      status: SESSION_STATUS.PUBLISHED,
      ...(responseDeadlineAt !== undefined
        ? { responseDeadlineAt: responseDeadlineAt ? new Date(responseDeadlineAt) : null }
        : {}),
    },
  });
}

/** Close catch-up: the session stays readable, comments stop. */
export async function closeSession(sessionId, _actorId = null) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  if (!session) throw new Error("Meeting session not found.");
  if (session.status === SESSION_STATUS.CLOSED) return session;

  return prisma.meetingSessions.update({
    where: { sessionId: id },
    data: { status: SESSION_STATUS.CLOSED },
  });
}

export async function cancelSession(sessionId, _actorId = null) {
  return prisma.meetingSessions.update({
    where: { sessionId: parseInt(sessionId) },
    data: { status: SESSION_STATUS.CANCELLED },
  });
}

/** Whether the session still accepts comments. */
export function acceptsResponses(session, now = new Date()) {
  if (!session) return false;
  if (session.status !== SESSION_STATUS.PUBLISHED && session.status !== SESSION_STATUS.LIVE) {
    return false;
  }
  if (!session.responseDeadlineAt) return true;
  return new Date(session.responseDeadlineAt) > now;
}

// ============================================================================
// Finalise -> event handoff (the pass phase one parked)
// ============================================================================

/**
 * Turn a finalised poll into the meeting it was deciding.
 *
 * Phase one created `events.internal` and `events.meetingPollId` and left
 * nothing writing them; this is that pass.  The event is the thing the session
 * hangs off, which is what lets a meeting exist with no poll behind it at all.
 *
 * `visibility` is set to "staff" rather than left at "public": every public
 * listing query filters on `visibility = 'public'` (see eventService), so this
 * keeps an internal staff meeting out of them without waiting for those queries
 * to learn about the `internal` flag.
 */
export async function finalizePollToSession(pollId, optionId, actorId, options = {}) {
  const id = parseInt(pollId);

  const poll = await prisma.meetingPolls.findUnique({
    where: { pollId: id },
    include: { options: true, invitees: { where: { removedAt: null } } },
  });
  if (!poll) throw new Error("Meeting poll not found.");
  if (poll.status === "cancelled") throw new Error("A cancelled poll cannot be finalised.");

  const chosenId = intOrNull(optionId) ?? poll.finalizedOptionId;
  const chosen = poll.options.find((option) => option.optionId === chosenId);
  // The same validation 0042's comment promised: finalizedOptionId is not an FK,
  // so the service is what stops a poll being finalised onto someone else's slot.
  if (!chosen) throw new Error("The chosen time option does not belong to this poll.");

  const existingEvent = await prisma.events.findFirst({
    where: { meetingPollId: id, deletedAt: null },
  });
  if (existingEvent) {
    const existingSession = await prisma.meetingSessions.findUnique({
      where: { eventId: existingEvent.eventId },
    });
    if (existingSession) return { event: existingEvent, session: existingSession, created: false };
  }

  const event =
    existingEvent ||
    (await prisma.events.create({
      data: {
        title: poll.title,
        slug: await generateSlug(poll.title, chosen.startAt),
        description: poll.description || null,
        eventType: "once",
        startAt: chosen.startAt,
        endAt: chosen.endAt,
        timezone: poll.timezone || "UTC",
        status: "published",
        visibility: "staff",
        internal: true,
        meetingPollId: id,
        creatorId: actorId,
        publishedAt: new Date(),
      },
    }));

  await prisma.meetingPolls.update({
    where: { pollId: id },
    data: { status: "finalized", finalizedOptionId: chosen.optionId },
  });

  const session = await createSession(
    {
      eventId: event.eventId,
      audienceMode: options.audienceMode || SESSION_AUDIENCE_MODE.ROSTER,
      responseDeadlineAt: options.responseDeadlineAt || null,
      noteRevealMode: options.noteRevealMode || REVEAL_MODE.IMMEDIATE,
      agendaItems: options.agendaItems || [],
    },
    actorId
  );

  return { event, session, created: true };
}

// ============================================================================
// Attendees
// ============================================================================

/**
 * Rebuild the attendee list.
 *
 * Three sources, in priority order: the poll roster when the event carries a
 * `meetingPollId` (the people who were actually asked about the time), the
 * LuckPerms ranks named by the caller, and manual additions.
 *
 * Existing rows are updated in place rather than deleted and recreated, so a
 * chair's role, their `attendedLive` flag and their `notifiedAt` all survive a
 * refresh.  Someone who has fallen out of every source is soft-removed, keeping
 * their comments and notes intact if they come back.
 */
export async function refreshAttendees(sessionId, { rankSlugs = null } = {}) {
  const id = parseInt(sessionId);

  const session = await prisma.meetingSessions.findUnique({
    where: { sessionId: id },
    include: { event: { select: { meetingPollId: true } } },
  });
  if (!session) throw new Error("Meeting session not found.");

  /** userId -> { source, viaRankSlug, canRespond } */
  const resolved = new Map();
  let unresolved = [];

  const pollId = session.event?.meetingPollId;
  if (pollId) {
    const invitees = await prisma.meetingPollInvitees.findMany({
      where: { pollId, removedAt: null },
    });
    for (const invitee of invitees) {
      resolved.set(invitee.userId, {
        source: "poll",
        viaRankSlug: invitee.viaRankSlug,
        canRespond: invitee.canRespond,
      });
    }
  }

  const slugs = (rankSlugs || []).map((slug) => String(slug).trim()).filter(Boolean);
  if (slugs.length > 0) {
    const expansion = await expandRanksToInvitees(slugs);
    unresolved = expansion.unresolved;
    for (const invitee of expansion.invitees) {
      // A poll attribution wins: it records that this person was actually asked
      // about the time, which a rank expansion does not.
      if (resolved.has(invitee.userId)) continue;
      resolved.set(invitee.userId, {
        source: "role",
        viaRankSlug: invitee.viaRankSlug,
        canRespond: invitee.canRespond,
      });
    }
  }

  const existing = await prisma.meetingSessionAttendees.findMany({ where: { sessionId: id } });
  const existingByUserId = new Map(existing.map((row) => [row.userId, row]));

  for (const [userId, attrs] of resolved) {
    const current = existingByUserId.get(userId);

    if (current) {
      await prisma.meetingSessionAttendees.update({
        where: { attendeeId: current.attendeeId },
        data: {
          canRespond: attrs.canRespond,
          // A manual add stays manual, and a role set by the chair is never
          // overwritten by a re-expansion.
          source: current.source === "manual" ? "manual" : attrs.source,
          viaRankSlug: current.source === "manual" ? current.viaRankSlug : attrs.viaRankSlug,
          removedAt: null,
        },
      });
    } else {
      await prisma.meetingSessionAttendees.create({
        data: {
          sessionId: id,
          userId,
          source: attrs.source,
          viaRankSlug: attrs.viaRankSlug,
          canRespond: attrs.canRespond,
        },
      });
    }
  }

  const staleIds = existing
    .filter((row) => row.source !== "manual" && !resolved.has(row.userId) && !row.removedAt)
    .map((row) => row.attendeeId);

  if (staleIds.length > 0) {
    await prisma.meetingSessionAttendees.updateMany({
      where: { attendeeId: { in: staleIds } },
      data: { removedAt: new Date() },
    });
  }

  return { rosterSize: resolved.size, unresolved };
}

/** Add someone by hand, outside the poll roster and the rank expansion. */
export async function addManualAttendee(sessionId, userId, role = ATTENDEE_ROLE.ATTENDEE) {
  const id = parseInt(sessionId);
  const uid = parseInt(userId);

  const user = await prisma.users.findUnique({ where: { userId: uid } });
  if (!user) throw new Error("User not found.");

  // The same eligibility rule the rank expansion applies, so a person added by
  // hand and the same person picked up by their rank are judged identically.
  const { canRespond } = classifyInviteeEligibility(user);
  const attendeeRole = oneOf(role, ATTENDEE_ROLE_VALUES, ATTENDEE_ROLE.ATTENDEE);

  return prisma.meetingSessionAttendees.upsert({
    where: { sessionId_userId: { sessionId: id, userId: uid } },
    create: { sessionId: id, userId: uid, source: "manual", role: attendeeRole, canRespond },
    update: { source: "manual", role: attendeeRole, canRespond, removedAt: null },
  });
}

/**
 * Set someone's role.
 *
 * Only ever called explicitly by the chair.  Nothing anywhere derives a role
 * from who spoke: a presenter who says little would lose speaker access to the
 * minutes, and an observer who talks a lot would gain it.
 */
export async function setAttendeeRole(sessionId, userId, role) {
  const attendeeRole = oneOf(role, ATTENDEE_ROLE_VALUES, null);
  if (!attendeeRole) throw new Error(`Role must be one of: ${ATTENDEE_ROLE_VALUES.join(", ")}.`);

  return prisma.meetingSessionAttendees.update({
    where: { sessionId_userId: { sessionId: parseInt(sessionId), userId: parseInt(userId) } },
    data: { role: attendeeRole },
  });
}

/** Soft-remove, keeping their comments and notes readable. */
export async function removeAttendee(sessionId, userId) {
  return prisma.meetingSessionAttendees.updateMany({
    where: { sessionId: parseInt(sessionId), userId: parseInt(userId) },
    data: { removedAt: new Date() },
  });
}

/**
 * Mark someone present from a Discord voice event.
 *
 * Attendance only — it never touches `role`.  Resolved through `users.discordId`;
 * a speaker with no linked website account simply is not marked, which is
 * better than inventing an attendee row keyed on nothing.
 */
export async function markAttendedLive({ sessionId, discordUserId }) {
  if (!discordUserId) return null;

  const user = await prisma.users.findFirst({
    where: { discordId: String(discordUserId) },
    select: { userId: true },
  });
  if (!user) return null;

  const id = parseInt(sessionId);

  const attendee = await prisma.meetingSessionAttendees.findUnique({
    where: { sessionId_userId: { sessionId: id, userId: user.userId } },
  });

  if (!attendee) {
    // Someone who turned up without being on the roster is added as an
    // observer, so the record of who was actually there is complete.  Observer,
    // not attendee: being in the call is not a grant of access to the minutes.
    return prisma.meetingSessionAttendees.create({
      data: {
        sessionId: id,
        userId: user.userId,
        source: "manual",
        role: ATTENDEE_ROLE.OBSERVER,
        attendedLive: true,
      },
    });
  }

  return prisma.meetingSessionAttendees.update({
    where: { attendeeId: attendee.attendeeId },
    data: { attendedLive: true, removedAt: null },
  });
}

/**
 * Who has not caught up yet.
 *
 * Reads `respondedAt`, not `lastOffsetMs`: scrubbing to the end is not the same
 * as responding.  People who cannot respond at all (no usable website login)
 * are returned separately rather than silently counted as outstanding forever.
 */
export async function outstandingResponses(sessionId) {
  const id = parseInt(sessionId);

  const [attendees, progress] = await Promise.all([
    prisma.meetingSessionAttendees.findMany({ where: { sessionId: id, removedAt: null } }),
    prisma.meetingSessionProgress.findMany({ where: { sessionId: id, respondedAt: { not: null } } }),
  ]);

  const respondedUserIds = new Set(progress.map((row) => row.userId));

  const userIds = attendees.map((a) => a.userId);
  const users = userIds.length
    ? await prisma.users.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, username: true, discordId: true },
      })
    : [];
  const userById = new Map(users.map((user) => [user.userId, user]));

  const decorate = (attendee) => ({
    userId: attendee.userId,
    username: userById.get(attendee.userId)?.username || null,
    discordId: userById.get(attendee.userId)?.discordId || null,
    role: attendee.role,
    attendedLive: attendee.attendedLive,
    notifiedAt: attendee.notifiedAt,
  });

  const responders = attendees.filter((a) => respondedUserIds.has(a.userId));
  const outstanding = attendees.filter((a) => a.canRespond && !respondedUserIds.has(a.userId));
  const blocked = attendees.filter((a) => !a.canRespond && !respondedUserIds.has(a.userId));

  return {
    total: attendees.length,
    respondedCount: responders.length,
    outstanding: outstanding.map(decorate),
    // Shown to the organiser rather than dropped: they are the people who need
    // chasing by some other means.
    cannotRespond: blocked.map(decorate),
  };
}

// ============================================================================
// Agenda
// ============================================================================

export async function createAgendaItem(sessionId, data) {
  const id = parseInt(sessionId);

  const last = await prisma.meetingAgendaItems.findFirst({
    where: { sessionId: id },
    orderBy: { orderIndex: "desc" },
  });

  const title = trimOrNull(data?.title, 255);
  if (!title) throw new Error("An agenda item needs a title.");

  return prisma.meetingAgendaItems.create({
    data: {
      sessionId: id,
      title,
      brief: trimOrNull(data?.brief),
      orderIndex: Number.isInteger(data?.orderIndex) ? data.orderIndex : (last?.orderIndex ?? -1) + 1,
      hiddenUntilReached: Boolean(data?.hiddenUntilReached),
    },
  });
}

/**
 * Edit an agenda item.
 *
 * `startOffsetMs` and `endOffsetMs` are editable — a chair who hit "next" a
 * minute late needs to be able to correct the chapter — but an explicit null is
 * honoured, because clearing a stamp is how an item is put back to "not
 * discussed".
 */
export async function updateAgendaItem(itemId, data) {
  const id = parseInt(itemId);
  const updateData = {};

  if (data.title !== undefined) {
    const title = trimOrNull(data.title, 255);
    if (!title) throw new Error("An agenda item needs a title.");
    updateData.title = title;
  }
  if (data.brief !== undefined) updateData.brief = trimOrNull(data.brief);
  if (data.orderIndex !== undefined) updateData.orderIndex = parseInt(data.orderIndex) || 0;
  if (data.status !== undefined) {
    updateData.status = oneOf(data.status, Object.values(AGENDA_ITEM_STATUS), AGENDA_ITEM_STATUS.PENDING);
  }
  if (data.hiddenUntilReached !== undefined) {
    updateData.hiddenUntilReached = Boolean(data.hiddenUntilReached);
  }
  if (data.startOffsetMs !== undefined) updateData.startOffsetMs = offsetOrNull(data.startOffsetMs);
  if (data.endOffsetMs !== undefined) updateData.endOffsetMs = offsetOrNull(data.endOffsetMs);

  return prisma.meetingAgendaItems.update({ where: { itemId: id }, data: updateData });
}

/**
 * Delete an agenda item.  Its comments and notes are NOT deleted — the FKs are
 * SET NULL — so the discussion and the decisions recorded under it survive as
 * general items on the session.
 */
export async function deleteAgendaItem(itemId) {
  return prisma.meetingAgendaItems.delete({ where: { itemId: parseInt(itemId) } });
}

export async function reorderAgendaItems(sessionId, orderedItemIds) {
  const id = parseInt(sessionId);
  const ids = (orderedItemIds || []).map((value) => parseInt(value)).filter(Number.isInteger);

  await prisma.$transaction(
    ids.map((itemId, index) =>
      prisma.meetingAgendaItems.updateMany({
        // Scoped to the session so a stray id from another meeting cannot be
        // renumbered through this endpoint.
        where: { itemId, sessionId: id },
        data: { orderIndex: index },
      })
    )
  );

  return prisma.meetingAgendaItems.findMany({ where: { sessionId: id }, orderBy: { orderIndex: "asc" } });
}

/**
 * Move to the next agenda item: close the open one, stamp the next.
 *
 * This is what makes the recording navigable — the chair walking the agenda
 * writes the chapter list as they go, with no AI chaptering anywhere.  Called
 * from both `/meeting next` in Discord and the dashboard button, which is the
 * shared-controller pattern working as intended: the chair can stamp the
 * timeline from inside the call while they are talking.
 */
export async function advanceAgenda({ sessionId, eventId = null, actorId = null, now = new Date() }) {
  const session = sessionId
    ? await prisma.meetingSessions.findUnique({ where: { sessionId: parseInt(sessionId) } })
    : await prisma.meetingSessions.findUnique({ where: { eventId: parseInt(eventId) } });

  if (!session) throw new Error("Meeting session not found.");
  if (!session.startedAt) throw new Error("The meeting has not started yet.");

  const at = currentOffsetMs(session, now);
  const items = await prisma.meetingAgendaItems.findMany({
    where: { sessionId: session.sessionId },
    orderBy: { orderIndex: "asc" },
  });

  const plan = planAgendaAdvance(
    items.map((item) => ({ ...item, startOffsetMs: num(item.startOffsetMs), endOffsetMs: num(item.endOffsetMs) })),
    at
  );

  if (plan.close) {
    await prisma.meetingAgendaItems.update({
      where: { itemId: plan.close.itemId },
      data: { endOffsetMs: plan.close.endOffsetMs, status: plan.close.status },
    });
  }

  if (plan.start) {
    await prisma.meetingAgendaItems.update({
      where: { itemId: plan.start.itemId },
      data: { startOffsetMs: plan.start.startOffsetMs },
    });
  }

  const closed = plan.close ? items.find((item) => item.itemId === plan.close.itemId) : null;
  const started = plan.start ? items.find((item) => item.itemId === plan.start.itemId) : null;

  return { atOffsetMs: at, closed: closed || null, started: started || null, actorId };
}

// ============================================================================
// Notes
// ============================================================================

function normaliseNoteInput(data, session) {
  const body = trimOrNull(data?.body);
  if (!body) throw new Error("A note needs a body.");

  const revealMode = oneOf(data?.revealMode, REVEAL_MODE_VALUES, session?.noteRevealMode || REVEAL_MODE.IMMEDIATE);

  return {
    kind: oneOf(data?.kind, Object.values(NOTE_KIND), NOTE_KIND.NOTE),
    body,
    visibility: oneOf(data?.visibility, VISIBILITY_VALUES, VISIBILITY.ATTENDEES),
    revealMode,
    // Only meaningful for their own mode; storing them regardless would make a
    // later mode change silently reveal or hide a note on an old value.
    revealAtOffsetMs: revealMode === REVEAL_MODE.ON_PLAYBACK ? offsetOrNull(data?.revealAtOffsetMs) : null,
    revealAt: revealMode === REVEAL_MODE.SCHEDULED && data?.revealAt ? new Date(data.revealAt) : null,
    agendaItemId: intOrNull(data?.agendaItemId),
  };
}

export async function createNote(sessionId, data, authorUserId) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  assertSessionEditable(session);

  const last = await prisma.meetingNotes.findFirst({
    where: { sessionId: id },
    orderBy: { orderIndex: "desc" },
  });

  return prisma.meetingNotes.create({
    data: {
      sessionId: id,
      authorUserId,
      orderIndex: (last?.orderIndex ?? -1) + 1,
      ...normaliseNoteInput(data, session),
    },
  });
}

export async function updateNote(noteId, data, actorUserId, { isManager = false } = {}) {
  const id = parseInt(noteId);
  const note = await prisma.meetingNotes.findUnique({
    where: { noteId: id },
    include: { session: true },
  });
  if (!note || note.deletedAt) throw new Error("Note not found.");

  // A note is the author's record of what was said.  A manager may edit one —
  // the chair correcting the minutes is a normal thing — but nobody else may.
  if (note.authorUserId !== actorUserId && !isManager) {
    throw new Error("You can only edit your own notes.");
  }

  const merged = normaliseNoteInput({ ...note, ...data }, note.session);
  const updateData = { ...merged };
  if (data.orderIndex !== undefined) updateData.orderIndex = parseInt(data.orderIndex) || 0;

  return prisma.meetingNotes.update({ where: { noteId: id }, data: updateData });
}

/** Soft delete, so an item's minutes can be restored if withdrawn by mistake. */
export async function deleteNote(noteId, actorUserId, { isManager = false } = {}) {
  const id = parseInt(noteId);
  const note = await prisma.meetingNotes.findUnique({ where: { noteId: id } });
  if (!note) throw new Error("Note not found.");
  if (note.authorUserId !== actorUserId && !isManager) {
    throw new Error("You can only delete your own notes.");
  }

  return prisma.meetingNotes.update({ where: { noteId: id }, data: { deletedAt: new Date() } });
}

// ============================================================================
// Comments
// ============================================================================

/**
 * Post a comment, live or catching up.
 *
 * Both go in the same table so the discussion on an agenda item reads as one
 * thread; `postedLive` is the only difference, and it is derived from the
 * session status rather than trusted from the client.
 *
 * Posting also marks the author as having responded — which is the entire point
 * of catch-up tracking: someone who has said something has engaged with the
 * meeting, and should drop off the organiser's chase list.
 */
export async function createComment(sessionId, data, userId, { now = new Date() } = {}) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  if (!session) throw new Error("Meeting session not found.");
  if (!acceptsResponses(session, now)) {
    throw new Error("This meeting is no longer accepting comments.");
  }

  const kind = oneOf(data?.kind, Object.values(COMMENT_KIND), COMMENT_KIND.TEXT);
  const body = trimOrNull(data?.body);

  if (kind === COMMENT_KIND.TEXT && !body) throw new Error("A comment needs some text.");
  if (kind === COMMENT_KIND.VOICE && !data?.audioPath) {
    throw new Error("A voice note needs an audio file.");
  }

  // A reply inherits its parent's anchor point, so a thread stays together on
  // the timeline rather than scattering across the scrubber.
  const parentCommentId = intOrNull(data?.parentCommentId);
  let atOffsetMs = offsetOrNull(data?.atOffsetMs);
  let agendaItemId = intOrNull(data?.agendaItemId);

  if (parentCommentId) {
    const parent = await prisma.meetingComments.findUnique({ where: { commentId: parentCommentId } });
    if (!parent || parent.sessionId !== id) {
      throw new Error("That comment is not on this meeting.");
    }
    if (atOffsetMs == null) atOffsetMs = num(parent.atOffsetMs);
    if (agendaItemId == null) agendaItemId = parent.agendaItemId;
  }

  const comment = await prisma.meetingComments.create({
    data: {
      sessionId: id,
      agendaItemId,
      parentCommentId,
      userId,
      kind,
      atOffsetMs,
      body,
      audioPath: data?.audioPath || null,
      audioPublicId: data?.audioPublicId || null,
      audioDurationMs: offsetOrNull(data?.audioDurationMs),
      // A voice note is queued for the transcription cron; text has nothing to
      // transcribe and is marked skipped rather than left pending forever.
      transcriptStatus: kind === COMMENT_KIND.VOICE ? TRANSCRIPT_STATUS.PENDING : TRANSCRIPT_STATUS.SKIPPED,
      visibility: oneOf(data?.visibility, VISIBILITY_VALUES, VISIBILITY.ATTENDEES),
      postedLive: session.status === SESSION_STATUS.LIVE,
    },
  });

  await markResponded(id, userId, now);

  return comment;
}

export async function updateComment(commentId, data, actorUserId, { isManager = false } = {}) {
  const id = parseInt(commentId);
  const comment = await prisma.meetingComments.findUnique({ where: { commentId: id } });
  if (!comment || comment.deletedAt) throw new Error("Comment not found.");
  if (comment.userId !== actorUserId && !isManager) {
    throw new Error("You can only edit your own comments.");
  }

  const updateData = {};
  if (data.body !== undefined) updateData.body = trimOrNull(data.body);
  if (data.visibility !== undefined) {
    updateData.visibility = oneOf(data.visibility, VISIBILITY_VALUES, comment.visibility);
  }
  if (data.atOffsetMs !== undefined) updateData.atOffsetMs = offsetOrNull(data.atOffsetMs);
  if (data.agendaItemId !== undefined) updateData.agendaItemId = intOrNull(data.agendaItemId);

  return prisma.meetingComments.update({ where: { commentId: id }, data: updateData });
}

/**
 * Soft delete, so a reply thread stays readable when its parent is withdrawn.
 *
 * Any attached voice note is removed from storage here, because a hidden
 * comment whose audio is still fetchable by URL is not deleted in any sense the
 * author would recognise.
 */
export async function deleteComment(commentId, actorUserId, { isManager = false } = {}) {
  const id = parseInt(commentId);
  const comment = await prisma.meetingComments.findUnique({ where: { commentId: id } });
  if (!comment) throw new Error("Comment not found.");
  if (comment.userId !== actorUserId && !isManager) {
    throw new Error("You can only delete your own comments.");
  }

  if (comment.audioPublicId) {
    const { deleteAsset } = await import("./cloudinaryService.js");
    // Best effort: the record must still be marked deleted even if the storage
    // call fails, and the janitor cron sweeps whatever is left behind.
    await deleteAsset(comment.audioPublicId).catch((error) =>
      console.error("[meetingSession] voice note delete failed:", error?.message ?? error)
    );
  }

  return prisma.meetingComments.update({
    where: { commentId: id },
    data: { deletedAt: new Date(), audioPath: null, audioPublicId: null },
  });
}

// ============================================================================
// Recordings
// ============================================================================

/**
 * File a recording against the session.
 *
 * `startOffsetMs` is where the file sits on the session timeline, so a bot
 * reconnect produces a second row at a non-zero offset rather than a corrupted
 * first one.  `storagePublicId` is stored alongside the URL because Cloudinary's
 * destroy() takes the id — persisting only the URL would leave an asset nothing
 * could ever delete.
 */
export async function addRecording({
  sessionId,
  source = RECORDING_SOURCE.DISCORD_BOT,
  storagePath,
  storagePublicId = null,
  mimeType = null,
  byteSize = null,
  durationMs = null,
  startOffsetMs = 0,
  trackUserId = null,
  trackIndex = 0,
  discordGuildId = null,
  discordChannelId = null,
  transcriptStatus = TRANSCRIPT_STATUS.PENDING,
}) {
  if (!storagePath) throw new Error("A recording needs a storage path.");

  return prisma.meetingRecordings.create({
    data: {
      sessionId: parseInt(sessionId),
      source: oneOf(source, Object.values(RECORDING_SOURCE), RECORDING_SOURCE.DISCORD_BOT),
      storagePath: String(storagePath).slice(0, 512),
      storagePublicId,
      mimeType,
      byteSize: byteSize == null ? null : BigInt(Math.round(Number(byteSize))),
      durationMs: durationMs == null ? null : BigInt(Math.round(Number(durationMs))),
      startOffsetMs: BigInt(offsetOrNull(startOffsetMs) ?? 0),
      trackUserId: intOrNull(trackUserId),
      trackIndex: parseInt(trackIndex) || 0,
      discordGuildId,
      discordChannelId,
      transcriptStatus,
    },
  });
}

/**
 * Delete a recording row and the asset behind it.
 *
 * Storage first, then the row: losing the row while the asset survives leaves
 * an orphan nothing references and nothing can find again.  Losing the asset
 * while the row survives is recoverable — the janitor and the organiser can
 * both see a recording whose file has gone.
 */
export async function deleteRecording(recordingId) {
  const id = parseInt(recordingId);
  const recording = await prisma.meetingRecordings.findUnique({ where: { recordingId: id } });
  if (!recording) throw new Error("Recording not found.");

  const { deleteAsset } = await import("./cloudinaryService.js");

  if (recording.storagePublicId) {
    await deleteAsset(recording.storagePublicId);
  }
  if (recording.transcriptPublicId) {
    // `raw`, matching how it was uploaded.  Passing the wrong resource type
    // makes Cloudinary answer "not found" about a perfectly present asset, and
    // the caller concludes the cleanup worked.
    await deleteAsset(recording.transcriptPublicId, { resourceType: "raw" }).catch((error) =>
      console.error("[meetingSession] transcript delete failed:", error?.message ?? error)
    );
  }

  return prisma.meetingRecordings.delete({ where: { recordingId: id } });
}

/**
 * Record one burst of speech.
 *
 * These intervals are what buy diarisation — who said what on the transcript —
 * from a single mixed-down file, without keeping a separate audio track per
 * speaker at ~11.5 MB per minute each.
 */
export async function logSpeakingInterval({
  sessionId,
  discordUserId,
  userId = null,
  startOffsetMs,
  endOffsetMs = null,
}) {
  return prisma.meetingSpeakingIntervals.create({
    data: {
      sessionId: parseInt(sessionId),
      userId: intOrNull(userId),
      discordUserId: discordUserId ? String(discordUserId) : null,
      startOffsetMs: BigInt(offsetOrNull(startOffsetMs) ?? 0),
      endOffsetMs: endOffsetMs == null ? null : BigInt(offsetOrNull(endOffsetMs) ?? 0),
    },
  });
}

export async function closeSpeakingInterval(intervalId, endOffsetMs) {
  return prisma.meetingSpeakingIntervals.update({
    where: { intervalId: parseInt(intervalId) },
    data: { endOffsetMs: BigInt(offsetOrNull(endOffsetMs) ?? 0) },
  });
}

export async function getSpeakingIntervals(sessionId) {
  const rows = await prisma.meetingSpeakingIntervals.findMany({
    where: { sessionId: parseInt(sessionId) },
    orderBy: { startOffsetMs: "asc" },
  });

  return rows.map((row) => ({
    ...row,
    startOffsetMs: num(row.startOffsetMs),
    endOffsetMs: num(row.endOffsetMs),
  }));
}

// ============================================================================
// Progress
// ============================================================================

/**
 * Remember how far a viewer has played.
 *
 * `lastOffsetMs` only ever moves forward: the player reports position
 * continuously, and a scrub back to re-listen to something must not lose the
 * fact that they had already reached the end.
 */
export async function recordProgress({ sessionId, userId, lastOffsetMs, completed = false, responded = false, now = new Date() }) {
  const id = parseInt(sessionId);
  const uid = parseInt(userId);
  const offset = offsetOrNull(lastOffsetMs) ?? 0;

  const existing = await prisma.meetingSessionProgress.findUnique({
    where: { sessionId_userId: { sessionId: id, userId: uid } },
  });

  const furthest = Math.max(offset, num(existing?.lastOffsetMs) ?? 0);

  return prisma.meetingSessionProgress.upsert({
    where: { sessionId_userId: { sessionId: id, userId: uid } },
    create: {
      sessionId: id,
      userId: uid,
      lastOffsetMs: BigInt(furthest),
      completedAt: completed ? now : null,
      respondedAt: responded ? now : null,
    },
    update: {
      lastOffsetMs: BigInt(furthest),
      // Neither timestamp is ever cleared by a later update: they record that
      // something happened, not the current state of a checkbox.
      ...(completed && !existing?.completedAt ? { completedAt: now } : {}),
      ...(responded && !existing?.respondedAt ? { respondedAt: now } : {}),
    },
  });
}

/** "I'm caught up", and the implicit version of it triggered by commenting. */
export async function markResponded(sessionId, userId, now = new Date()) {
  const id = parseInt(sessionId);
  const uid = parseInt(userId);

  return prisma.meetingSessionProgress.upsert({
    where: { sessionId_userId: { sessionId: id, userId: uid } },
    create: { sessionId: id, userId: uid, lastOffsetMs: BigInt(0), respondedAt: now },
    update: { respondedAt: now },
  });
}

// ============================================================================
// Archive
// ============================================================================

/** Queue a bundle build.  The cron picks it up; nothing is built in-request. */
export async function requestArchive(sessionId) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  if (!session) throw new Error("Meeting session not found.");

  return prisma.meetingSessions.update({
    where: { sessionId: id },
    data: planArchiveRequest(session),
  });
}

/**
 * A human states they have opened the bundle and it is intact.
 *
 * This — and only this — unlocks deleting the hosted audio.  It is deliberately
 * not something the archive builder can do to itself.
 */
export async function confirmArchive(sessionId, _actorId = null, now = new Date()) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });
  if (!session) throw new Error("Meeting session not found.");
  if (!canConfirmArchive(session)) {
    throw new Error("There is no ready archive on this session to confirm.");
  }

  return prisma.meetingSessions.update({
    where: { sessionId: id },
    data: { archiveConfirmedAt: now },
  });
}

/**
 * Drop the hosted audio, keeping notes, comments and transcript.
 *
 * Every route to deleting audio comes through here, so there is one place to
 * read to know what protects the recordings.  `requireArchiveConfirmed` is
 * threaded through for the retention cron, whose policy is configurable — but
 * it defaults to on, and turning it off is a visible act in config.
 */
export async function removeSessionAudio(sessionId, { requireArchiveConfirmed = true, now = new Date() } = {}) {
  const id = parseInt(sessionId);
  const session = await prisma.meetingSessions.findUnique({ where: { sessionId: id } });

  const blocked = audioRemovalBlockedReason(session, { requireArchiveConfirmed });
  if (blocked) throw new Error(blocked);
  if (!canRemoveAudio(session, { requireArchiveConfirmed })) {
    throw new Error("The audio for this session cannot be removed yet.");
  }

  const recordings = await prisma.meetingRecordings.findMany({ where: { sessionId: id } });
  const { deleteAsset } = await import("./cloudinaryService.js");

  let removed = 0;
  for (const recording of recordings) {
    if (!recording.storagePublicId) continue;
    try {
      await deleteAsset(recording.storagePublicId);
      // The row is kept, with its duration, offset and transcript: the timeline
      // has to stay reconstructable after the audio is gone.
      await prisma.meetingRecordings.update({
        where: { recordingId: recording.recordingId },
        data: { storagePath: "", storagePublicId: null },
      });
      removed += 1;
    } catch (error) {
      console.error(
        `[meetingSession] failed to delete audio for recording #${recording.recordingId}:`,
        error?.message ?? error
      );
    }
  }

  await prisma.meetingSessions.update({
    where: { sessionId: id },
    data: { audioRemovedAt: now },
  });

  return { removed, total: recordings.length };
}

/**
 * Delete a session outright.
 *
 * Every stored asset is removed first.  Cascades would take the rows and leave
 * the audio paid for and unreferenced in Cloudinary forever.
 */
export async function deleteSession(sessionId) {
  const id = parseInt(sessionId);

  const [recordings, voiceComments, session] = await Promise.all([
    prisma.meetingRecordings.findMany({ where: { sessionId: id } }),
    prisma.meetingComments.findMany({ where: { sessionId: id, audioPublicId: { not: null } } }),
    prisma.meetingSessions.findUnique({ where: { sessionId: id } }),
  ]);
  if (!session) throw new Error("Meeting session not found.");

  const { deleteAsset } = await import("./cloudinaryService.js");

  // Audio is stored as Cloudinary's `video` type; the archive zip and the
  // transcripts are `raw`.  destroy() silently reports "not found" when given
  // the wrong type, so each asset has to be deleted with the type it was
  // uploaded under or it survives and nothing says so.
  const assets = [
    ...recordings.map((r) => ({ publicId: r.storagePublicId, resourceType: "video" })),
    ...recordings.map((r) => ({ publicId: r.transcriptPublicId, resourceType: "raw" })),
    ...voiceComments.map((c) => ({ publicId: c.audioPublicId, resourceType: "video" })),
    { publicId: session.archivePublicId, resourceType: "raw" },
  ].filter((asset) => asset.publicId);

  for (const asset of assets) {
    await deleteAsset(asset.publicId, { resourceType: asset.resourceType }).catch((error) =>
      console.error("[meetingSession] asset delete failed:", error?.message ?? error)
    );
  }

  return prisma.meetingSessions.delete({ where: { sessionId: id } });
}
