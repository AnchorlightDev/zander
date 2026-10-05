/**
 * Decides whether a guild member should receive the "please verify" DM.
 *
 * The linked users row is the source of truth for verification: nothing
 * assigns the verified Discord role when an account is linked, so relying on
 * the role alone DMs players who already linked. The role still counts as
 * verified for anyone staff marked by hand.
 *
 * @param {{ id: string, user: { bot: boolean }, roles: { cache: Map<string, unknown> } }} member
 * @param {Set<string>} linkedDiscordIds Discord IDs linked to a real (non-placeholder) user.
 * @param {string} [verifiedRoleId]
 */
export function needsVerificationReminder(member, linkedDiscordIds, verifiedRoleId) {
  if (member.user.bot) return false;
  if (linkedDiscordIds.has(String(member.id))) return false;
  if (verifiedRoleId && member.roles.cache.has(verifiedRoleId)) return false;
  // Only members with at least one role beyond @everyone are known to the server.
  return member.roles.cache.size > 1;
}
