/**
 * lib/oidc/accounts.mjs
 *
 * The oidc-provider "Account" — maps a CFC user to OIDC claims, and is the
 * single place the STAFF GATE is enforced for tokens.
 *
 * `findAccount` is called by oidc-provider when it issues or refreshes a token.
 * We re-read the user's effective groups LIVE every time and return `undefined`
 * if they no longer hold a staff group. Returning undefined makes the grant fail
 * (invalid_grant), which is exactly the brief's rule: "On refresh, re-read
 * groups; refuse the refresh if the user no longer holds a staff group." The
 * same check at initial authorize is surfaced more gently by the interaction
 * handler (routes/oidcRoutes.js), which shows a clear "staff only" message.
 *
 * Claims issued: sub (CFC user ID), preferred_username, groups (effective groups
 * — inherited, global-context, non-expiring), and discord_id when linked.
 */

import { createRequire } from "module";
import { prisma } from "../../controllers/databaseController.js";
import { getEffectiveGroups, isStaff } from "../permissions/effectiveGroups.mjs";
import { buildClaims } from "./claims.mjs";
import { resolveAvatarUrl } from "../avatarHelpers.js";

const require = createRequire(import.meta.url);
const config = require("../config/config.cjs");

/** Staff groups are configuration, not code (config.compass.staffGroups). */
export function staffGroups() {
  return config?.compass?.staffGroups || [];
}

/**
 * Load a CFC user and their current effective groups, returning an oidc-provider
 * Account — or undefined if the user is missing, disabled, or no longer staff.
 */
export async function findAccount(ctx, accountId) {
  const userId = Number(accountId);
  if (!Number.isInteger(userId)) return undefined;

  const user = await prisma.users.findUnique({
    where: { userId },
    select: {
      userId: true, uuid: true, username: true, discordId: true, account_disabled: true,
      profilePicture_type: true, profilePicture_email: true,
    },
  });
  if (!user || user.account_disabled) return undefined;

  const groups = await getEffectiveGroups({
    uuid: user.uuid,
    userId: user.userId,
    username: user.username,
  });

  // Staff gate: no staff group → no token. Enforced on every issue and refresh.
  if (!isStaff(groups, staffGroups())) return undefined;

  user.picture = await resolveAvatarUrl(user).catch(() => null);
  return buildAccount(user, groups);
}

/** Build the Account object oidc-provider consumes. Exposed for the interaction handler. */
export function buildAccount(user, groups) {
  return {
    accountId: String(user.userId),
    async claims(use, scope) {
      return buildClaims(user, groups, scope);
    },
  };
}

/**
 * Resolve the effective groups + staff status for a logged-in CFC user, used by
 * the interaction handler to decide between "finish sign-in" and "staff only".
 */
export async function resolveStaffStatus(userId) {
  const user = await prisma.users.findUnique({
    where: { userId: Number(userId) },
    select: { userId: true, uuid: true, username: true, discordId: true, account_disabled: true },
  });
  if (!user || user.account_disabled) return { ok: false, reason: "no_account" };

  const groups = await getEffectiveGroups({
    uuid: user.uuid,
    userId: user.userId,
    username: user.username,
  });
  if (!isStaff(groups, staffGroups())) return { ok: false, reason: "not_staff", user, groups };

  return { ok: true, user, groups };
}
