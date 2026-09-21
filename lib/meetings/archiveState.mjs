/**
 * lib/meetings/archiveState.mjs
 *
 * The archive state machine, and the rule that guards the only irreversible
 * step in this module.
 *
 *   none ──request──> requested ──cron──> building ──┬──> ready ──human──> confirmed
 *                          ^                          └──> failed
 *                          └──────── retry ───────────────────┘
 *
 * Hosted audio may only be deleted once `archiveConfirmedAt` is set, and that
 * is set by a person who has opened the bundle — not by the job that built it.
 * "The download finished, so it must be safe" is exactly how meetings get lost:
 * a zip that streamed to completion around a mid-build error is still a zip,
 * and nobody finds out until the year-old recording is wanted.
 *
 * Pure — no database import — so the guard is unit-testable, which is the whole
 * point of pulling it out of the service.
 */

export const ARCHIVE_STATUS = {
  NONE: "none",
  REQUESTED: "requested",
  BUILDING: "building",
  READY: "ready",
  FAILED: "failed",
};

export const ARCHIVE_STATUS_VALUES = Object.values(ARCHIVE_STATUS);

/** Legal moves. Anything not listed is rejected rather than quietly allowed. */
const TRANSITIONS = {
  [ARCHIVE_STATUS.NONE]: [ARCHIVE_STATUS.REQUESTED],
  [ARCHIVE_STATUS.REQUESTED]: [ARCHIVE_STATUS.BUILDING, ARCHIVE_STATUS.FAILED],
  [ARCHIVE_STATUS.BUILDING]: [ARCHIVE_STATUS.READY, ARCHIVE_STATUS.FAILED],
  // A rebuild is allowed: an archive that has been superseded by later notes is
  // worth rebuilding, and a confirmed one keeps its confirmation only if the
  // new bundle is confirmed too (see planArchiveRequest).
  [ARCHIVE_STATUS.READY]: [ARCHIVE_STATUS.REQUESTED],
  [ARCHIVE_STATUS.FAILED]: [ARCHIVE_STATUS.REQUESTED],
};

export function canTransitionArchive(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertArchiveTransition(from, to) {
  if (!canTransitionArchive(from, to)) {
    throw new Error(`Cannot move an archive from "${from}" to "${to}".`);
  }
}

/** Nothing to archive until the meeting has actually happened. */
const ARCHIVABLE_SESSION_STATUSES = new Set(["published", "closed"]);

/**
 * Whether the organiser may request (or re-request) a bundle.
 *
 * Refuses while one is already building, so a double-click does not start two
 * archivers writing the same path.
 */
export function canRequestArchive(session) {
  if (!session) return false;
  if (!ARCHIVABLE_SESSION_STATUSES.has(session.status)) return false;
  return canTransitionArchive(session.archiveStatus, ARCHIVE_STATUS.REQUESTED);
}

/**
 * The state change a request applies.
 *
 * A rebuild clears `archiveConfirmedAt`: the confirmation belonged to the old
 * bundle, and carrying it over would let a never-checked rebuild authorise the
 * audio deletion that the old, checked one had authorised.
 */
export function planArchiveRequest(session) {
  if (!canRequestArchive(session)) {
    throw new Error(
      `This session cannot be archived while it is ${session?.status} / ${session?.archiveStatus}.`
    );
  }

  return {
    archiveStatus: ARCHIVE_STATUS.REQUESTED,
    archiveConfirmedAt: null,
    archiveBuiltAt: null,
  };
}

/**
 * Whether a human may mark the bundle as checked.  Requires a bundle that
 * actually exists — a `ready` row with no path is a bug, and confirming it
 * would licence deleting the audio it was supposed to replace.
 */
export function canConfirmArchive(session) {
  if (!session) return false;
  if (session.archiveStatus !== ARCHIVE_STATUS.READY) return false;
  if (!session.archivePath) return false;
  return !session.archiveConfirmedAt;
}

/**
 * THE GUARD.  Whether the hosted audio may be deleted.
 *
 * Every path to deleting audio — the organiser doing it by hand, and the
 * retention cron doing it on a schedule — goes through this one function, so
 * there is a single place to read to know what is protecting the recordings.
 *
 * `requireArchiveConfirmed` exists because retention is configurable, not
 * because the check is optional: an operator who genuinely wants audio dropped
 * on age alone has to turn it off in config and can be seen to have done so.
 * It defaults to on.
 */
export function canRemoveAudio(session, { requireArchiveConfirmed = true } = {}) {
  if (!session) return false;
  if (session.audioRemovedAt) return false;

  if (requireArchiveConfirmed) {
    if (session.archiveStatus !== ARCHIVE_STATUS.READY) return false;
    if (!session.archiveConfirmedAt) return false;
  }

  return true;
}

/**
 * Why deletion was refused, for the message shown to the organiser.  Returns
 * null when it is allowed, so callers read as
 * `const reason = audioRemovalBlockedReason(s); if (reason) throw ...`.
 */
export function audioRemovalBlockedReason(session, options = {}) {
  if (!session) return "Session not found.";
  if (session.audioRemovedAt) return "The audio for this session has already been removed.";

  if (options.requireArchiveConfirmed !== false) {
    if (session.archiveStatus !== ARCHIVE_STATUS.READY) {
      return "Build an archive of this session before removing its audio.";
    }
    if (!session.archiveConfirmedAt) {
      return "Download the archive and confirm it opens before removing the audio.";
    }
  }

  return null;
}

/**
 * Whether the retention policy has aged this session out.
 *
 * Retention is measured from the meeting, not from the archive: what matters is
 * how old the recording is, and `archiveBuiltAt` would let a late archive keep
 * audio alive indefinitely.
 */
export function isPastRetention(session, { retentionDays, now = new Date() } = {}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return false;

  const anchor = session?.endedAt || session?.startedAt || session?.createdAt;
  if (!anchor) return false;

  return new Date(anchor).getTime() + days * 86_400_000 <= now.getTime();
}
