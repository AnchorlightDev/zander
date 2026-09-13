/**
 * controllers/userAccountState.js
 *
 * Pure, framework-free helpers for classifying the real state of a `users`
 * row for the staff Users dashboard. These functions take plain objects and
 * never touch the database — see controllers/usersAdminController.js for the
 * SQL predicates that must stay in sync with the logic here.
 */

export const ACCOUNT_STATE = {
  REGISTERED: "REGISTERED",
  REGISTRATION_INCOMPLETE: "REGISTRATION_INCOMPLETE",
  MINECRAFT_PROFILE_ONLY: "MINECRAFT_PROFILE_ONLY",
};

/**
 * Classify a `users` row into one of three account states.
 *
 * A row can exist purely because a player joined Minecraft (see
 * POST /api/user/create) with no email/password/discordId ever set — that is
 * "Minecraft profile only". Registration is only "complete" once
 * account_registered has been stamped AND a password exists; anything with
 * partial credentials (email/password set mid-flow, or a Discord-only
 * forcelink with no local password) is "incomplete", since a discordId alone
 * does not prove a working local login exists.
 *
 * @param {{email?: string|null, password_hash?: string|null, account_registered?: Date|string|null}} user
 * @returns {"REGISTERED"|"REGISTRATION_INCOMPLETE"|"MINECRAFT_PROFILE_ONLY"}
 */
export function classifyAccountState(user) {
  const email = user?.email ?? null;
  const passwordHash = user?.password_hash ?? null;
  const accountRegistered = user?.account_registered ?? null;

  if (accountRegistered && passwordHash) {
    return ACCOUNT_STATE.REGISTERED;
  }

  if (!email && !passwordHash && !accountRegistered) {
    return ACCOUNT_STATE.MINECRAFT_PROFILE_ONLY;
  }

  return ACCOUNT_STATE.REGISTRATION_INCOMPLETE;
}

/**
 * Derive Java vs Bedrock from the Floodgate `.` username prefix convention
 * (mirrors routes/sessionRoutes.js — there is no persisted platform column).
 *
 * @param {string} username
 * @returns {"JAVA"|"BEDROCK"}
 */
export function derivePlatform(username) {
  return typeof username === "string" && username.startsWith(".") ? "BEDROCK" : "JAVA";
}

/**
 * Whether a staff-triggered password reset can actually do anything.
 * Mirrors the public /forgot-password gate (routes/sessionRoutes.js) —
 * email + password_hash must both be set — plus an added account_disabled
 * check, since this is a new privileged action and disabled accounts
 * shouldn't be able to regain access via staff-triggered resets.
 *
 * @param {{email?: string|null, password_hash?: string|null, account_disabled?: boolean}} user
 * @returns {boolean}
 */
export function isPasswordResetEligible(user) {
  return Boolean(user?.email && user?.password_hash && !user?.account_disabled);
}

/**
 * Silent permission check (no side effects, no DB/session dependency beyond
 * the array of node strings) for view-conditional UI — e.g. deciding whether
 * to show a "Reveal email" button. Mirrors hasSpecificPermission in
 * api/common.js, but that function is paired with hasPermission(), which
 * always renders the no-permission page on failure; this is used only to
 * toggle optional UI, never as the actual route guard.
 *
 * @param {string} node
 * @param {string[]|undefined} permissions
 * @returns {boolean}
 */
export function hasPermissionSilent(node, permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) return false;

  const target = String(node).trim().toLowerCase();
  return permissions.some((p) => {
    if (!p) return false;
    const candidate = String(p).trim().toLowerCase();
    if (candidate === "*") return true;
    if (candidate === target) return true;
    if (candidate.endsWith(".*")) {
      const base = candidate.slice(0, -2);
      return target === base || target.startsWith(base + ".");
    }
    return false;
  });
}

/**
 * Mask an email address for default display, e.g. "ce***@gmail.com".
 * Keeps the first 2 characters of the local part (1 if the local part is
 * shorter) and the full domain.
 *
 * @param {string|null|undefined} email
 * @returns {string|null}
 */
export function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return null;
  }

  const [localPart, domain] = email.split("@");
  const visibleLength = Math.min(2, Math.max(1, localPart.length - 1));
  const visible = localPart.slice(0, visibleLength);

  return `${visible}***@${domain}`;
}
