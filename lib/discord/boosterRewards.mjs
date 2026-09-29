/**
 * lib/discord/boosterRewards.mjs
 *
 * Booster rewards: linked members with an active boost on the Discord server
 * get the configured LuckPerms rank(s); the ranks go when the boost ends.
 *
 * This module is the pure part -- what should change and the exact console
 * commands -- so it is unit-testable. Storage and the Discord/LuckPerms
 * lookups are in controllers/boosterRewardController.js.
 *
 * Settings (Settings → Discord):
 *   discord.boosterRewards.enabled     boolean
 *   discord.boosterRewards.rankGroups  LuckPerms group names
 */

/** A LuckPerms group name: one token, so it cannot change a command's shape. */
export const RANK_GROUP_PATTERN = /^[A-Za-z0-9_.-]{1,36}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid, de-duplicated, lower-cased group names (LuckPerms stores them lower-case). */
export function normaliseRankGroups(groups) {
  if (!Array.isArray(groups)) return [];
  const out = new Set();
  for (const group of groups) {
    const name = String(group ?? "").trim().toLowerCase();
    if (RANK_GROUP_PATTERN.test(name)) out.add(name);
  }
  return [...out];
}

/** The console command that adds or removes one group for one player. */
export function buildRankCommand(action, uuid, rankGroup) {
  if (action !== "add" && action !== "remove") throw new Error(`Unknown action: ${action}`);
  if (!UUID_PATTERN.test(String(uuid))) throw new Error("Invalid player uuid.");
  if (!RANK_GROUP_PATTERN.test(String(rankGroup))) throw new Error("Invalid rank group.");
  return `lp user ${String(uuid).toLowerCase()} parent ${action} ${String(rankGroup).toLowerCase()}`;
}

/**
 * Work out which grants to add and which to revoke.
 *
 * @param {object}   args
 * @param {boolean}  args.enabled
 * @param {string[]} args.rankGroups          configured groups
 * @param {Set<string>} args.boosterDiscordIds members currently boosting (within scope)
 * @param {Map<string, {userId:number, uuid:string}>} args.linkedByDiscordId
 *        real (non-placeholder) linked accounts for the Discord IDs in scope
 * @param {Array<{userId:number, discordId:string, uuid:string, rankGroup:string}>} args.grants
 *        grants this feature has already made (within scope)
 * @returns {{ toGrant: Array, toRevoke: Array }}
 */
export function planBoosterRewards({ enabled, rankGroups, boosterDiscordIds, linkedByDiscordId, grants }) {
  const groups = enabled ? normaliseRankGroups(rankGroups) : [];
  const desired = new Map();

  for (const discordId of boosterDiscordIds ?? []) {
    const account = linkedByDiscordId?.get(String(discordId));
    if (!account || !UUID_PATTERN.test(String(account.uuid))) continue;
    for (const rankGroup of groups) {
      desired.set(`${account.userId}|${rankGroup}`, {
        userId: account.userId,
        discordId: String(discordId),
        uuid: String(account.uuid).toLowerCase(),
        rankGroup,
      });
    }
  }

  const existing = new Map((grants ?? []).map((g) => [`${g.userId}|${String(g.rankGroup).toLowerCase()}`, g]));

  return {
    toGrant: [...desired].filter(([key]) => !existing.has(key)).map(([, g]) => g),
    toRevoke: [...existing].filter(([key]) => !desired.has(key)).map(([, g]) => g),
  };
}
