/**
 * lib/oidc/claims.mjs
 *
 * Pure mapping from a CFC user + their effective groups to OIDC claims, split
 * out from accounts.mjs so it carries no database/config imports and is unit
 * testable on its own.
 *
 * Claims (per the Compass brief):
 *   sub                — the CFC user ID (always)
 *   preferred_username — when the `profile` scope is granted
 *   groups             — effective groups, when the `groups` scope is granted
 *   discord_id         — only when the account is linked to Discord
 */

export function buildClaims(user, groups, scope) {
  const requested = new Set(
    String(scope || "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const claims = { sub: String(user.userId) };

  if (requested.has("profile")) {
    claims.preferred_username = user.username;
  }
  if (requested.has("groups")) {
    claims.groups = Array.isArray(groups) ? groups : [];
  }
  if (user.discordId) {
    claims.discord_id = user.discordId;
  }

  return claims;
}
