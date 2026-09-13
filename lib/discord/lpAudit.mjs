// AUDIT ONLY — this module never adds or removes Discord roles.
// All role mutation logic must live in a separate module.
// When a future sync engine is built, it must only run when
// a dedicated `sync_enabled` config flag is true, and must
// never import or call anything from this file to mutate roles.

import db, { luckpermsDb } from "../../controllers/databaseController.js";

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) reject(error);
      else resolve(results);
    });
  });
}

function runLuckPermsQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => {
      if (error) reject(error);
      else resolve(results);
    });
  });
}

// LuckPerms lives on a separate MySQL server from the main app DB, so none
// of this can be read via the (cross-server, unreliable) `ranks`/
// `luckPermsPlayers` views or a hardcoded `cfcdev_luckperms.*` schema
// reference — every lookup below queries luckpermsDb and db independently
// and merges in JS (same pattern as services/profileService.js:getUserRanks).

/**
 * Fetch all ranks that have a Discord role ID configured.
 * @returns {Promise<Map<string, string>>} Map of rankSlug → discordRoleId
 */
export async function getTrackedRanks() {
  const rows = await runLuckPermsQuery(
    `SELECT name AS rankSlug, SUBSTRING_INDEX(permission, '.', -1) AS discordRoleId
       FROM luckperms_group_permissions
      WHERE permission LIKE 'meta.discordid.%' AND value = 1
        AND server = 'global' AND world = 'global'`
  );
  const map = new Map();
  for (const row of rows) {
    if (row.discordRoleId) map.set(row.rankSlug, row.discordRoleId);
  }
  return map;
}

/**
 * Fetch all LP users who hold at least one tracked LP group (active, non-expired).
 * Queries the LP permissions table directly so expiry is respected.
 * @returns {Promise<Array<{uuid, username, discordId, lpGroups}>>}
 */
export async function getTrackedLPUsers() {
  const ranksMap = await getTrackedRanks();
  const trackedRankSlugs = [...ranksMap.keys()];
  if (!trackedRankSlugs.length) return [];

  const groupRows = await runLuckPermsQuery(
    `SELECT uuid, SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
       FROM luckperms_user_permissions
      WHERE permission LIKE 'group.%' AND value = 1
        AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())
        AND SUBSTRING_INDEX(permission, '.', -1) IN (?)`,
    [trackedRankSlugs]
  );
  if (!groupRows.length) return [];

  const lpGroupsByUuid = new Map();
  for (const row of groupRows) {
    const uuid = row.uuid.toLowerCase();
    if (!lpGroupsByUuid.has(uuid)) lpGroupsByUuid.set(uuid, new Set());
    lpGroupsByUuid.get(uuid).add(row.rankSlug);
  }
  const uuids = [...lpGroupsByUuid.keys()];

  const [webUsers, lpPlayers] = await Promise.all([
    runQuery(`SELECT uuid, username, discordId FROM users WHERE uuid IN (?)`, [uuids]),
    runLuckPermsQuery(`SELECT LOWER(uuid) AS uuid, username FROM luckperms_players WHERE LOWER(uuid) IN (?)`, [uuids]),
  ]);

  const webByUuid = new Map(webUsers.map((u) => [u.uuid.toLowerCase(), u]));
  const lpNameByUuid = new Map(lpPlayers.map((p) => [p.uuid, p.username]));

  return uuids.map((uuid) => {
    const webUser = webByUuid.get(uuid);
    return {
      uuid,
      username: webUser?.username || lpNameByUuid.get(uuid) || uuid,
      discordId: webUser?.discordId && webUser.discordId.trim() ? webUser.discordId.trim() : null,
      lpGroups: [...lpGroupsByUuid.get(uuid)],
    };
  });
}

/**
 * Given a user's LP groups and the tracked ranks map, return the Discord role IDs
 * they are expected to hold.
 * @param {string[]} lpGroups
 * @param {Map<string, string>} ranksMap
 * @returns {string[]}
 */
export function computeExpectedRoles(lpGroups, ranksMap) {
  const roleIds = [];
  for (const group of lpGroups) {
    const roleId = ranksMap.get(group);
    if (roleId) roleIds.push(roleId);
  }
  return roleIds;
}

/**
 * Fetch the set of Discord IDs that are already linked in our system.
 * Used to detect guild members who hold tracked roles but have no link.
 * @returns {Promise<Set<string>>}
 */
async function getLinkedDiscordIds() {
  const rows = await runQuery(
    `SELECT discordId FROM users WHERE discordId IS NOT NULL AND discordId != ''`
  );
  return new Set(rows.map((r) => r.discordId.trim()));
}

/**
 * Run the full LP ↔ Discord audit. This function is read-only and never
 * assigns or removes any Discord roles.
 *
 * @param {import("discord.js").Guild} guild
 * @returns {Promise<{
 *   unlinked: Array<{uuid, username, lpGroups, expectedRoleIds}>,
 *   notInGuild: Array<{uuid, username, discordId, lpGroups, expectedRoleIds}>,
 *   missingRoles: Array<{uuid, username, discordId, lpGroups, missingRoles, missingRoleIds}>,
 *   discordNotLinked: Array<{discordId, discordTag, heldRoles, heldRoleIds}>,
 *   summary: {total, trackedRankCount}
 * }>}
 */
export async function runAudit(guild) {
  const ranksMap = await getTrackedRanks();
  const trackedRankCount = ranksMap.size;

  if (trackedRankCount === 0) {
    return {
      unlinked: [],
      notInGuild: [],
      missingRoles: [],
      discordNotLinked: [],
      summary: { total: 0, trackedRankCount: 0 },
    };
  }

  // Run DB and Discord fetches in parallel.
  const [lpUsers, linkedDiscordIds, guildMembersFetched] = await Promise.all([
    getTrackedLPUsers(),
    getLinkedDiscordIds(),
    guild.members.fetch().catch((err) => {
      console.error("[lpaudit] Failed to bulk-fetch guild members:", err);
      return new Map();
    }),
  ]);

  const guildMembers = guildMembersFetched;

  // Reverse map: discordRoleId → rankSlug (for readable output)
  const slugByRoleId = new Map(
    [...ranksMap.entries()].map(([slug, id]) => [id, slug])
  );
  const allTrackedRoleIds = new Set(ranksMap.values());

  const unlinked = [];
  const notInGuild = [];
  const missingRoles = [];
  const discordNotLinked = [];

  for (const user of lpUsers) {
    // Section A: no Discord ID recorded in our system.
    // expectedRoleIds records what a sync would need to remove.
    if (!user.discordId) {
      unlinked.push({
        uuid: user.uuid,
        username: user.username,
        lpGroups: user.lpGroups,
        expectedRoleIds: computeExpectedRoles(user.lpGroups, ranksMap),
      });
      continue;
    }

    const member = guildMembers.get(user.discordId);

    // Section B: Discord ID exists but user is not in the guild.
    // expectedRoleIds records what a sync would need to remove.
    if (!member) {
      notInGuild.push({
        uuid: user.uuid,
        username: user.username,
        discordId: user.discordId,
        lpGroups: user.lpGroups,
        expectedRoleIds: computeExpectedRoles(user.lpGroups, ranksMap),
      });
      continue;
    }

    // Section C: in guild but missing one or more expected Discord roles
    const expectedRoleIds = computeExpectedRoles(user.lpGroups, ranksMap);
    const missingRoleIds = expectedRoleIds.filter(
      (id) => !member.roles.cache.has(id)
    );

    if (missingRoleIds.length > 0) {
      missingRoles.push({
        uuid: user.uuid,
        username: user.username,
        discordId: user.discordId,
        lpGroups: user.lpGroups,
        missingRoles: missingRoleIds.map((id) => slugByRoleId.get(id) || id),
        missingRoleIds,
      });
    }
  }

  // Section D: guild members who hold tracked Discord roles but are not linked
  // in our system at all. Approached from the Discord side so we catch people
  // like a player who was manually given a role and never linked their account.
  for (const [memberId, member] of guildMembers) {
    if (linkedDiscordIds.has(memberId)) continue;

    const heldRoleIds = [...allTrackedRoleIds].filter((id) =>
      member.roles.cache.has(id)
    );
    if (heldRoleIds.length === 0) continue;

    discordNotLinked.push({
      discordId: memberId,
      discordTag: member.user.tag,
      heldRoles: heldRoleIds.map((id) => slugByRoleId.get(id) || id),
      heldRoleIds,
    });
  }

  return {
    unlinked,
    notInGuild,
    missingRoles,
    discordNotLinked,
    summary: { total: lpUsers.length, trackedRankCount },
  };
}
