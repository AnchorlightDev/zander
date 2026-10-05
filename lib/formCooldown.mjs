/**
 * lib/formCooldown.mjs
 *
 * How long after a denial someone has to wait before applying again.
 *
 * Imports nothing, and takes both the clock and the last decision as
 * arguments, so the arithmetic can be checked against a fixed clock rather
 * than whatever today happens to be.
 *
 * Only denials start a clock. Approved and pending submissions are still
 * governed by `forms.allowMultiple`, which this deliberately leaves alone.
 */

const MS_PER_DAY = 86400000;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "22 September 2026", in UTC.
 *
 * Formatted by hand rather than through toLocaleDateString: the output is
 * shown to applicants and asserted in tests, and neither wants it shifting
 * with the host's locale data or timezone.
 */
export function formatCooldownDate(date) {
  const at = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** When a cooldown started at `reviewedAt` runs out, or null when there is none. */
export function cooldownEndsAt(reviewedAt, cooldownDays) {
  const days = Number(cooldownDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (!reviewedAt) return null;

  const from = reviewedAt instanceof Date ? reviewedAt : new Date(reviewedAt);
  if (Number.isNaN(from.getTime())) return null;

  return new Date(from.getTime() + Math.round(days) * MS_PER_DAY);
}

/**
 * Is this person still inside a reapply cooldown?
 *
 * `lastDenial` is the most recent denied submission, or null when there is
 * none. Returns { blocked, until, message } -- `until` is null when nothing is
 * blocking, so callers can render the date without re-deriving it.
 *
 * Boundary: the cooldown is over *at* its end, not a day after. Someone denied
 * on the 1st with a 7-day cooldown may reapply from the 8th, at the same time
 * of day the decision was made.
 *
 * A denial with no reviewedAt (a row decided before that column was populated,
 * or written by hand) does not start a clock -- blocking on a timestamp that
 * does not exist would be a permanent block nobody could clear.
 */
export function evaluateCooldown({ lastDenial = null, cooldownDays = null, now = new Date() } = {}) {
  const until = cooldownEndsAt(lastDenial?.reviewedAt, cooldownDays);
  if (!until) return { blocked: false, until: null, message: null };

  if (now.getTime() >= until.getTime()) {
    return { blocked: false, until: null, message: null };
  }

  return {
    blocked: true,
    until,
    message: `Your last application was not successful. You can apply again on ${formatCooldownDate(until)}.`,
  };
}
