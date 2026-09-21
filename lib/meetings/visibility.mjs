/**
 * lib/meetings/visibility.mjs
 *
 * Who may see which note and which comment, and when.
 *
 * Two separate mechanisms, deliberately kept apart:
 *
 *   visibility — public | attendees | speakers | private.  A real access
 *                control.  Enforced as a Prisma `where` fragment so the rows
 *                never come back from the database at all.
 *
 *   reveal     — immediate | on_playback | scheduled.  *Timing*, not access:
 *                it decides when someone who is already allowed to read a note
 *                gets to read it.
 *
 * Both are applied here, in the query path, and never in a template.  A blurred
 * <div> whose text is sitting in the page source is a styling effect, not a
 * permission: a hidden body must not leave the server.  `selectVisibleNotes`
 * therefore drops rows outright rather than flagging them, so a hidden note has
 * no `body` in the payload to find.
 *
 * Pure — no database import — so every combination of visibility, viewer role
 * and reveal boundary is unit-testable without a session.
 */

export const VISIBILITY = {
  /** Anyone who can open the session at all. */
  PUBLIC: "public",
  /** On the session roster. */
  ATTENDEES: "attendees",
  /** On the roster with role chair or speaker. */
  SPEAKERS: "speakers",
  /** The author, and nobody else — not even a manager. */
  PRIVATE: "private",
};

export const REVEAL_MODE = {
  IMMEDIATE: "immediate",
  ON_PLAYBACK: "on_playback",
  SCHEDULED: "scheduled",
};

export const ATTENDEE_ROLE = {
  CHAIR: "chair",
  SPEAKER: "speaker",
  ATTENDEE: "attendee",
  OBSERVER: "observer",
};

/** Roles that clear the `speakers` bar. */
const SPEAKER_ROLES = new Set([ATTENDEE_ROLE.CHAIR, ATTENDEE_ROLE.SPEAKER]);

export const VISIBILITY_VALUES = Object.values(VISIBILITY);
export const REVEAL_MODE_VALUES = Object.values(REVEAL_MODE);
export const ATTENDEE_ROLE_VALUES = Object.values(ATTENDEE_ROLE);

/**
 * Build the viewer context the rest of this file takes.
 *
 * @param {object}  args
 * @param {number?} args.userId     the viewer, or null for a signed-out caller
 * @param {boolean} args.isManager  holds zander.web.meetings.manage
 * @param {object?} args.attendee   the viewer's meetingSessionAttendees row
 */
export function buildViewer({ userId = null, isManager = false, attendee = null } = {}) {
  const onRoster = Boolean(attendee) && !attendee.removedAt;

  return {
    userId: userId == null ? null : parseInt(userId),
    isManager: Boolean(isManager),
    isAttendee: onRoster,
    role: onRoster ? attendee.role : null,
    // A manager is treated as speaker-level for visibility purposes: they can
    // already edit the session, its agenda and its minutes, so withholding the
    // speakers-only minutes from them would be theatre rather than a control.
    // `private` is the one thing this does not reach — see below.
    isSpeaker: (onRoster && SPEAKER_ROLES.has(attendee.role)) || Boolean(isManager),
    isChair: (onRoster && attendee.role === ATTENDEE_ROLE.CHAIR) || Boolean(isManager),
  };
}

/**
 * The set of `visibility` values this viewer may read, ignoring authorship.
 * `private` is never in it — that is handled by the author clause instead,
 * because it depends on the row, not on the viewer.
 */
export function readableVisibilities(viewer) {
  const allowed = [VISIBILITY.PUBLIC];
  if (viewer?.isAttendee || viewer?.isManager) allowed.push(VISIBILITY.ATTENDEES);
  if (viewer?.isSpeaker) allowed.push(VISIBILITY.SPEAKERS);
  return allowed;
}

/**
 * A Prisma `where` fragment restricting rows to what this viewer may read.
 *
 * `authorField` differs between the two tables the fragment is used on:
 * meetingNotes keys authorship on `authorUserId`, meetingComments on `userId`.
 *
 * A `private` row is reachable only by its own author.  A manager is
 * deliberately excluded: "private" that the organiser can read is not private,
 * and the people writing these notes need the distinction to mean something.
 */
export function visibilityWhere(viewer, { authorField = "authorUserId" } = {}) {
  const clauses = [{ visibility: { in: readableVisibilities(viewer) } }];

  if (viewer?.userId != null) {
    clauses.push({ visibility: VISIBILITY.PRIVATE, [authorField]: viewer.userId });
  }

  return { OR: clauses };
}

/**
 * A Prisma `where` fragment for the part of reveal that SQL can decide on its
 * own: `immediate` always, `scheduled` once its time has passed.
 *
 * `on_playback` is let through here and settled by selectVisibleNotes below,
 * because its fallback reads the agenda item's `startOffsetMs` — a value on
 * another table that a plain where clause cannot reach.  Those rows are
 * filtered before the payload is built, so a body that is not yet revealed is
 * still never serialised out.
 */
export function revealWhere(viewer, now = new Date()) {
  // The author always sees their own drafts, and a manager needs unrevealed
  // notes in the editor, so neither is gated on reveal at all.
  if (viewer?.isManager) return {};

  const clauses = [
    { revealMode: REVEAL_MODE.IMMEDIATE },
    { revealMode: REVEAL_MODE.ON_PLAYBACK },
    { revealMode: REVEAL_MODE.SCHEDULED, revealAt: { not: null, lte: now } },
  ];

  if (viewer?.userId != null) {
    clauses.push({ authorUserId: viewer.userId });
  }

  return { OR: clauses };
}

/**
 * The playback offset at which an `on_playback` note becomes readable.
 *
 * Falls back to the agenda item's `startOffsetMs`, which is the case that
 * actually gets used: "show this note once the viewer reaches the item it
 * belongs to" then needs nothing filled in on the note itself.
 *
 * With neither — a general note, or one on an item the chair never reached —
 * the answer is 0, i.e. revealed straight away.  There is no later moment to
 * wait for, and the alternative is minutes that stay permanently hidden because
 * somebody forgot to advance the agenda.  Failing open is right here precisely
 * because on_playback is not a security control (see below); anything that must
 * genuinely be withheld uses `scheduled` or manual release.
 */
export function effectiveRevealOffsetMs(note, agendaItem = null) {
  if (note?.revealAtOffsetMs != null) return Number(note.revealAtOffsetMs);
  if (agendaItem?.startOffsetMs != null) return Number(agendaItem.startOffsetMs);
  return 0;
}

/**
 * Whether one note is revealed to this viewer right now.
 *
 * `playbackOffsetMs` is whatever the client last reported.  That is a request,
 * not proof — nothing stops a viewer posting a large number — so on_playback is
 * a reading-ahead deterrent and nothing more.  It is documented as such at
 * every layer so that nobody later mistakes it for a control and puts something
 * genuinely sensitive behind it.
 */
export function isRevealed(note, { agendaItem = null, viewer = null, playbackOffsetMs = 0, now = new Date() } = {}) {
  // Author and manager bypass: they need to see what they are about to release.
  if (viewer?.isManager) return true;
  if (viewer?.userId != null && note?.authorUserId === viewer.userId) return true;

  switch (note?.revealMode) {
    case REVEAL_MODE.SCHEDULED:
      return Boolean(note.revealAt) && new Date(note.revealAt) <= now;

    case REVEAL_MODE.ON_PLAYBACK:
      return Number(playbackOffsetMs || 0) >= effectiveRevealOffsetMs(note, agendaItem);

    case REVEAL_MODE.IMMEDIATE:
    default:
      // An unknown mode reads as immediate.  A note whose reveal mode is
      // corrupt is still minutes somebody is waiting on, and the visibility
      // check above has already decided they are allowed to read it.
      return true;
  }
}

/**
 * Whether this viewer may read a row at all, by visibility.  The in-process
 * mirror of visibilityWhere, for rows that were fetched for another reason.
 */
export function canReadVisibility(row, viewer, { authorField = "authorUserId" } = {}) {
  if (row?.visibility === VISIBILITY.PRIVATE) {
    return viewer?.userId != null && row[authorField] === viewer.userId;
  }
  return readableVisibilities(viewer).includes(row?.visibility);
}

/**
 * Final gate before serialisation: return only the notes this viewer may
 * actually read, right now.
 *
 * Rows are dropped, never flagged.  A caller that wants to show "3 notes are
 * not yet released" should count what came back against a separate count query
 * — it must not be handed the bodies and asked to hide them.
 *
 * @param {object[]} notes              rows, already narrowed by visibilityWhere
 * @param {object}   ctx
 * @param {object}   ctx.viewer
 * @param {Map}      ctx.agendaItemById itemId -> { startOffsetMs }
 * @param {number}   ctx.playbackOffsetMs  client-reported, see isRevealed
 * @param {Date}     ctx.now
 */
export function selectVisibleNotes(notes, { viewer, agendaItemById = new Map(), playbackOffsetMs = 0, now = new Date() } = {}) {
  return (notes || [])
    .filter((note) => !note.deletedAt)
    .filter((note) => canReadVisibility(note, viewer, { authorField: "authorUserId" }))
    .filter((note) =>
      isRevealed(note, {
        agendaItem: note.agendaItemId != null ? agendaItemById.get(note.agendaItemId) || null : null,
        viewer,
        playbackOffsetMs,
        now,
      })
    );
}

/**
 * The comment equivalent.  Comments carry visibility but no reveal — a comment
 * is posted into a conversation, and holding one back until a playback point
 * would make replies read out of order.
 */
export function selectVisibleComments(comments, { viewer } = {}) {
  return (comments || []).filter((comment) =>
    canReadVisibility(comment, viewer, { authorField: "userId" })
  );
}

/**
 * Agenda items this viewer may see.
 *
 * `hiddenUntilReached` keeps the not-yet-discussed part of the agenda away from
 * catch-up viewers.  The chair — and any manager — always sees the whole
 * agenda, otherwise they could not run the meeting from the page that is
 * hiding it from them.
 */
export function selectVisibleAgendaItems(items, { viewer } = {}) {
  if (viewer?.isChair) return items || [];
  return (items || []).filter((item) => !item.hiddenUntilReached || item.startOffsetMs != null);
}
