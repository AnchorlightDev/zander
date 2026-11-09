/**
 * Pure nickname policy helpers: the time and impersonation rules, with no
 * database or clock of their own (callers pass `now`). Unit-tested in isolation;
 * the controller wires them to real data.
 */

import { buildSkeleton, withinEditDistance } from "./nicknameValidation.mjs";

/** One change per 24 hours. */
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Old nicknames are held for 14 days after a change or clear. */
export const RESERVATION_MS = 14 * 24 * 60 * 60 * 1000;

/** Edit distance at or below which a nickname counts as impersonating staff. */
export const STAFF_EDIT_DISTANCE = 1;

function toMs(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Milliseconds remaining on the cooldown, or 0 if the user may change now.
 * A null/absent lastChangeAt (never set, or cleared by a staff reset) is no
 * cooldown.
 */
export function cooldownRemainingMs(lastChangeAt, now = Date.now()) {
  const last = toMs(lastChangeAt);
  if (last == null) return 0;
  const elapsed = now - last;
  if (elapsed >= COOLDOWN_MS) return 0;
  return COOLDOWN_MS - elapsed;
}

/** When the next change is allowed, as a Date (or null if allowed now). */
export function cooldownEndsAt(lastChangeAt, now = Date.now()) {
  const remaining = cooldownRemainingMs(lastChangeAt, now);
  return remaining > 0 ? new Date(now + remaining) : null;
}

/** The expiry Date for a reservation created now. */
export function reservationExpiry(now = Date.now()) {
  return new Date(now + RESERVATION_MS);
}

/** True while a reservation is still holding (reservedUntil in the future). */
export function isReservationActive(reservedUntil, now = Date.now()) {
  const until = toMs(reservedUntil);
  if (until == null) return false;
  return until > now;
}

/**
 * Resolve what a viewer should see for a player. The stored nickname is shown
 * only while the player currently holds the permission; otherwise they appear
 * under their real name (the nickname is "hidden", not deleted).
 *
 * @param {object} args
 * @param {string} args.username real username (always the fallback)
 * @param {{nickname?: string|null, color?: string|null}|null} args.nicknameRow
 * @param {boolean} args.holdsPermission
 * @returns {{display: string, nickname: string|null, color: string|null,
 *            isNick: boolean, hidden: boolean, realname: string}}
 */
export function resolveEffectiveNickname({ username, nicknameRow, holdsPermission }) {
  const stored = nicknameRow && nicknameRow.nickname ? String(nicknameRow.nickname) : null;
  if (stored && holdsPermission) {
    return {
      display: stored,
      nickname: stored,
      color: nicknameRow.color || null,
      isNick: true,
      hidden: false,
      realname: username,
    };
  }
  return {
    display: username,
    nickname: null,
    color: null,
    isNick: false,
    // A stored nickname the player can't currently show is hidden, not absent.
    hidden: Boolean(stored) && !holdsPermission,
    realname: username,
  };
}

/**
 * Decide whether a candidate skeleton impersonates someone. Pure: the caller
 * supplies the reference data it has already loaded.
 *
 * Rules (in order):
 *  - A variant of the player's OWN username is always allowed.
 *  - Reject if the skeleton belongs to another user's registered username.
 *  - Reject if it belongs to another user's active/hidden/reserved nickname.
 *  - Reject if it is within edit distance 1 of any staff member's
 *    username or nickname skeleton (excluding the player themselves).
 *
 * @param {object} args
 * @param {string} args.skeleton candidate skeleton
 * @param {number} args.ownUserId
 * @param {string} args.ownUsernameSkeleton skeleton of the player's own username
 * @param {Map<string, Array<number>>} args.usernameOwners skeleton -> userIds
 * @param {Map<string, Array<number>>} args.nicknameOwners skeleton -> userIds
 *        (covers active, hidden and reserved nicknames)
 * @param {Array<string>} args.staffSkeletons staff username/nickname skeletons
 * @returns {{ok: true} | {ok: false, code: string}}
 */
export function checkImpersonation({
  skeleton,
  ownUserId,
  ownUsernameSkeleton,
  usernameOwners = new Map(),
  nicknameOwners = new Map(),
  staffSkeletons = [],
}) {
  if (!skeleton) return { ok: false, code: "invalid_characters" };

  // A variant of the player's own name is explicitly allowed and bypasses the
  // player/staff similarity checks.
  if (ownUsernameSkeleton && skeleton === ownUsernameSkeleton) {
    return { ok: true };
  }

  const othersOnly = (owners) =>
    (owners || []).some((id) => Number(id) !== Number(ownUserId));

  if (othersOnly(usernameOwners.get(skeleton))) {
    return { ok: false, code: "impersonates_player" };
  }

  if (othersOnly(nicknameOwners.get(skeleton))) {
    return { ok: false, code: "reserved" };
  }

  for (const staff of staffSkeletons) {
    if (!staff) continue;
    // The player's own name appearing in the staff list is fine.
    if (staff === ownUsernameSkeleton) continue;
    if (withinEditDistance(skeleton, staff, STAFF_EDIT_DISTANCE)) {
      return { ok: false, code: "impersonates_player" };
    }
  }

  return { ok: true };
}

/** Convenience: skeleton of a username, for building reference sets. */
export function usernameSkeleton(username) {
  return buildSkeleton(username);
}
