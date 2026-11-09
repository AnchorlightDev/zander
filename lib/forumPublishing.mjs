/**
 * lib/forumPublishing.mjs
 *
 * Turns the new-discussion form's publishing choice into a stored state, in one
 * pure function so the route stays thin and the rules are unit-testable.
 *
 * Three modes:
 *   now      -> published immediately (the default).
 *   draft    -> saved, visible only to its author and moderators.
 *   schedule -> published later by the cron; needs the schedule permission and a
 *               future date/time.
 */

export const DISCUSSION_STATUSES = ["published", "draft", "scheduled"];

/**
 * @param {object} input
 * @param {string} input.mode         "now" | "draft" | "schedule" (anything else -> "now").
 * @param {string|Date|null} input.publishAt  Required for "schedule".
 * @param {boolean} input.canSchedule  Whether the user holds the schedule permission.
 * @param {Date} [input.now]           Injectable clock for tests.
 * @returns {{ ok: true, status: string, publishAt: Date|null } | { ok: false, error: string }}
 */
export function resolvePublishState({ mode, publishAt, canSchedule = false, now = new Date() }) {
  const chosen = String(mode || "now").toLowerCase();

  if (chosen === "draft") {
    return { ok: true, status: "draft", publishAt: null };
  }

  if (chosen === "schedule") {
    if (!canSchedule) {
      return { ok: false, error: "You do not have permission to schedule posts." };
    }
    const when = publishAt instanceof Date ? publishAt : new Date(publishAt);
    if (!publishAt || Number.isNaN(when.getTime())) {
      return { ok: false, error: "Choose a date and time to schedule this post." };
    }
    if (when.getTime() <= now.getTime()) {
      return { ok: false, error: "The scheduled time must be in the future." };
    }
    return { ok: true, status: "scheduled", publishAt: when };
  }

  // "now" and any unrecognised value publish immediately.
  return { ok: true, status: "published", publishAt: null };
}
