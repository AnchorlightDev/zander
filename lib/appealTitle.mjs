/**
 * lib/appealTitle.mjs
 *
 * Appeal tickets are titled `Appeal #<punishmentKey> - <type> - <date>`.
 * Match the key exactly: a substring test would let key "12" match an open
 * appeal for punishment 123.
 */

/** The punishment key in an appeal ticket title, or null. */
export function appealKeyFromTitle(title) {
  const match = String(title || "").match(/Appeal #([^\s]+)/);
  return match ? match[1] : null;
}

/** True when `title` is the appeal ticket for exactly `punishmentKey`. */
export function isAppealTitleFor(title, punishmentKey) {
  const key = appealKeyFromTitle(title);
  return key !== null && key === String(punishmentKey);
}
