/**
 * Diffs a member's current Discord roles against the roles they should have,
 * restricted to the set of role IDs that map to a rank (`trackedRoleIds`).
 * Role IDs outside that set are never touched, even if present in the inputs.
 */
export function diffTrackedRoles(currentRoleIds, shouldHaveRoleIds, trackedRoleIds) {
  const current = new Set(currentRoleIds);
  const shouldHave = new Set(shouldHaveRoleIds);
  const tracked = new Set(trackedRoleIds);

  const toAdd = [...shouldHave].filter((id) => tracked.has(id) && !current.has(id));
  const toRemove = [...current].filter((id) => tracked.has(id) && !shouldHave.has(id));

  return { toAdd, toRemove };
}

async function queryDb(sql, params = []) {
  const { default: db } = await import("../../controllers/databaseController.js");
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

async function queryLuckPermsDb(sql, params = []) {
  const { luckpermsDb } = await import("../../controllers/databaseController.js");
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

/**
 * LuckPerms lives on a separate MySQL server from the main app DB, so it
 * cannot be joined via a cross-database SQL view — every lookup here queries
 * luckpermsDb and db independently and merges in JS (same pattern as
 * services/profileService.js:getUserRanks, which is the proven-working
 * reference for this). Nodes are scoped to server='global'/world='global' to
 * match how the dashboard's rank config editor writes them
 * (updateGroupNode() in api/routes/ranks.js) — a contextual override (e.g.
 * server=events) would otherwise shadow the intended global value.
 */

/** Every distinct Discord role ID configured on any rank (rankSlug -> discordRoleId). */
async function getTrackedRoleMap() {
  const rows = await queryLuckPermsDb(
    `SELECT name AS rankSlug, SUBSTRING_INDEX(permission, '.', -1) AS discordRoleId
       FROM luckperms_group_permissions
      WHERE permission LIKE 'meta.discordid.%' AND value = 1
        AND server = 'global' AND world = 'global'`
  );
  const map = new Map();
  for (const row of rows) {
    if (row.discordRoleId) map.set(row.rankSlug, String(row.discordRoleId));
  }
  return map;
}

/** Every distinct Discord role ID configured on any rank. */
export async function getTrackedRoleIds() {
  const map = await getTrackedRoleMap();
  return [...map.values()];
}

/**
 * Lowercases a uuid for comparison against `luckperms_user_permissions.uuid`
 * — LuckPerms' MySQL storage uses standard dashed VARCHAR(36) uuids (see
 * services/profileService.js:getUserRanks), matching `users.uuid`'s own
 * dashed format. No dash-stripping needed here.
 */
export function normalizeUuid(uuid) {
  if (!uuid) return null;
  return String(uuid).toLowerCase();
}

/** Every LuckPerms group (rankSlug) the given player uuid directly holds. */
async function getUserRankSlugs(uuid) {
  const normalized = normalizeUuid(uuid);
  if (!normalized) return [];
  const rows = await queryLuckPermsDb(
    `SELECT SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
       FROM luckperms_user_permissions
      WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1
        AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
    [normalized]
  );
  return rows.map((r) => r.rankSlug);
}

/** Discord role IDs for every rank the given LuckPerms player uuid currently holds. */
export async function getUserRoleIdsByUuid(uuid) {
  const rankSlugs = await getUserRankSlugs(uuid);
  if (!rankSlugs.length) return [];
  const trackedRoleMap = await getTrackedRoleMap();
  return rankSlugs
    .map((slug) => trackedRoleMap.get(slug))
    .filter(Boolean);
}

import { client } from "../../controllers/discordController.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../../config.json");
const features = require("../../features.json");

async function fetchGuildMember(discordId) {
  const guildId = config.discord?.guildId;
  if (!guildId || !discordId) return null;

  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;

  return guild.members.fetch(discordId).catch(() => null);
}

/**
 * Grants/revokes the given user's rank-mapped Discord roles so their
 * Discord roles match their current LuckPerms ranks. Never throws — always
 * resolves to a result object describing what happened, so callers (e.g.
 * /forcelink) can surface sync failures instead of reporting blind success.
 */
export async function syncMemberRankRoles(userId) {
  if (!features.ranks) return { ok: false, reason: "FEATURE_DISABLED" };
  if (!userId) return { ok: false, reason: "NO_USER_ID" };

  try {
    const [webUser] = await queryDb(
      `SELECT uuid, discordId FROM users WHERE userId = ? LIMIT 1`,
      [userId]
    );
    if (!webUser?.discordId) return { ok: false, reason: "NOT_LINKED" };

    const member = await fetchGuildMember(webUser.discordId);
    if (!member) return { ok: false, reason: "MEMBER_NOT_IN_GUILD", discordId: webUser.discordId };

    const [trackedRoleIds, shouldHaveRoleIds] = await Promise.all([
      getTrackedRoleIds(),
      getUserRoleIdsByUuid(webUser.uuid),
    ]);

    const currentRoleIds = [...member.roles.cache.keys()];
    const { toAdd, toRemove } = diffTrackedRoles(currentRoleIds, shouldHaveRoleIds, trackedRoleIds);

    if (toAdd.length) await member.roles.add(toAdd);
    if (toRemove.length) await member.roles.remove(toRemove);

    return { ok: true, toAdd, toRemove, shouldHaveRoleIds, trackedRoleIds };
  } catch (error) {
    console.error(`[rankRoleSync] Failed to sync roles for userId ${userId}:`, error.message);
    return { ok: false, reason: "ERROR", error: error.message };
  }
}

/**
 * Removes every tracked rank role from the given Discord user. Used when a
 * Discord account is unlinked, since we can no longer resolve their ranks.
 */
export async function stripAllTrackedRankRoles(discordId) {
  if (!features.ranks || !discordId) return;

  try {
    const member = await fetchGuildMember(discordId);
    if (!member) return;

    const trackedRoleIds = await getTrackedRoleIds();
    const currentRoleIds = [...member.roles.cache.keys()];
    const toRemove = currentRoleIds.filter((id) => trackedRoleIds.includes(id));

    if (toRemove.length) await member.roles.remove(toRemove);
  } catch (error) {
    console.error(`[rankRoleSync] Failed to strip roles for discordId ${discordId}:`, error.message);
  }
}
