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

import { prisma } from "../../controllers/databaseController.js";
import { getEffectiveGroups, getStaffGrantIssues, isStaff } from "../permissions/effectiveGroups.mjs";
import { buildClaims } from "./claims.mjs";
import { resolveAvatarUrl } from "../avatarHelpers.js";
import { getStaffGroups } from "./staffGroups.mjs";

/**
 * Staff groups come from Compass's "Who can sign in" setting (pushed to Zander),
 * falling back to config.compass.staffGroups. See lib/oidc/staffGroups.mjs.
 */
export async function staffGroups() {
  return getStaffGroups();
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
  if (!isStaff(groups, await staffGroups())) return undefined;

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
  if (!user) return { ok: false, reason: "no_account" };
  if (user.account_disabled) return { ok: false, reason: "account_disabled", user, groups: [], issues: [] };

  const identity = { uuid: user.uuid, userId: user.userId, username: user.username };
  const [groups, allowed] = await Promise.all([getEffectiveGroups(identity), staffGroups()]);
  if (!isStaff(groups, allowed)) {
    // Explain the refusal: staff ranks the user holds that don't count
    // (server/world-specific, expired, or negated). Best effort only.
    const issues = await getStaffGrantIssues(identity, allowed).catch((error) => {
      console.error("[oidc] couldn't explain staff refusal:", error.message);
      return [];
    });
    console.warn(
      `[oidc] staff sign-in refused for ${user.username} (#${user.userId}): groups=[${groups.join(", ")}] ` +
        `issues=${JSON.stringify(issues)}`
    );
    return { ok: false, reason: "not_staff", user, groups, issues };
  }

  return { ok: true, user, groups };
}
