// cron/rankDiscordRoleSyncCron.js
/**
 * cron/rankDiscordRoleSyncCron.js
 *
 * Periodically reconciles Discord roles against LuckPerms rank membership,
 * for every rank that has a discordRoleId configured. Catches rank changes
 * made directly via LuckPerms (in-game/console) that bypass the dashboard API.
 *
 * Logic:
 *  1. Load all ranks with a discordRoleId set.
 *  2. For each such rank, find the linked website users (discordId) who
 *     currently hold that LuckPerms group.
 *  3. Fetch the full guild member list once.
 *  4. For each guild member, diff their current tracked roles against the
 *     roles their linked ranks say they should have, and add/remove as needed.
 *
 * Runs every 15 minutes.
 */

import cron from "node-cron";
import { client } from "../controllers/discordController.js";
import db, { luckpermsDb } from "../controllers/databaseController.js";
import { diffTrackedRoles } from "../lib/discord/rankRoleSync.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");

function queryDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function queryLuckPermsDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function reconcileRankDiscordRoles() {
  if (!features.ranks) return;

  const guildId = config.discord?.guildId;
  if (!guildId) return;

  try {
    // LuckPerms lives on a separate MySQL server, so this can't be read via
    // the (cross-server, unreliable) `ranks` view — query luckpermsDb
    // directly, scoped to server='global'/world='global' to match how the
    // dashboard's rank config editor writes these nodes.
    const rankRows = await queryLuckPermsDb(
      `SELECT name AS rankSlug, SUBSTRING_INDEX(permission, '.', -1) AS discordRoleId
         FROM luckperms_group_permissions
        WHERE permission LIKE 'meta.discordid.%' AND value = 1
          AND server = 'global' AND world = 'global'`
    );
    const ranks = rankRows.filter((r) => r.discordRoleId);
    if (ranks.length === 0) return;

    // Map: linked website userId -> Set of discordRoleIds they should have.
    const shouldHaveByUserId = new Map();
    let anyRankHadMembers = false;
    // A rank whose lookup failed must not take part in the removal sweep:
    // with no "should have" entries for it, every holder of its role would
    // otherwise be stripped until the next successful run.
    const failedRoleIds = new Set();

    for (const rank of ranks) {
      try {
        // luckperms_user_permissions.uuid is a standard dashed VARCHAR(36),
        // matching users.uuid's own dashed format directly (see
        // lib/discord/rankRoleSync.mjs normalizeUuid / services/profileService.js
        // getUserRanks for the same fix applied elsewhere).
        const lpRows = await queryLuckPermsDb(
          `SELECT LOWER(lup.uuid) AS uuid, LOWER(lp.username) AS username
             FROM luckperms_user_permissions lup
             LEFT JOIN luckperms_players lp ON lp.uuid = lup.uuid
            WHERE lup.permission = ? AND lup.value = 1
              AND (lup.expiry IS NULL OR lup.expiry = 0 OR lup.expiry > UNIX_TIMESTAMP())`,
          [`group.${rank.rankSlug}`]
        );
        if (lpRows.length === 0) continue;
        anyRankHadMembers = true;

        // Match on uuid only. A placeholder ("ghost") row's username is the
        // person's self-chosen Discord handle, so matching placeholders by
        // username let anyone claim a staff member's rank roles by copying
        // their Minecraft name. Placeholders are skipped by the sweep below
        // instead, so their roles are not stripped either.
        const uuids = lpRows.map((r) => r.uuid);
        const uuidPlaceholders = uuids.map(() => "?").join(", ");
        const webUsers = await queryDb(
          `SELECT userId, discordId FROM users
            WHERE discordId IS NOT NULL
              AND LOWER(uuid) IN (${uuidPlaceholders})`,
          uuids
        );

        for (const user of webUsers) {
          if (!shouldHaveByUserId.has(user.userId)) {
            shouldHaveByUserId.set(user.userId, { discordId: user.discordId, roleIds: new Set() });
          }
          shouldHaveByUserId.get(user.userId).roleIds.add(String(rank.discordRoleId));
        }
      } catch (err) {
        failedRoleIds.add(String(rank.discordRoleId));
        console.error(`[rankRoleSync-cron] Error resolving members for rank ${rank.rankSlug}:`, err.message);
      }
    }

    const trackedRoleIds = ranks
      .map((r) => String(r.discordRoleId))
      .filter((id) => !failedRoleIds.has(id));
    if (failedRoleIds.size) {
      console.warn(`[rankRoleSync-cron] ${failedRoleIds.size} rank(s) failed to resolve; their roles are left untouched this run.`);
    }
    if (trackedRoleIds.length === 0) return;

    // Circuit breaker: if every rank had LuckPerms members but NONE resolved to a
    // linked website account, something is wrong with the uuid mapping (not "nobody
    // is linked") — refuse to run the removal sweep rather than risk stripping every
    // guild member's roles.
    if (anyRankHadMembers && shouldHaveByUserId.size === 0) {
      console.warn("[rankRoleSync-cron] LuckPerms ranks have members but none resolved to a linked account — skipping sweep (possible uuid mapping bug).");
      return;
    }

    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      console.warn("[rankRoleSync-cron] Guild not found. Skipping.");
      return;
    }
    try {
      await guild.members.fetch({ time: 120_000 });
    } catch (err) {
      // "Members didn't arrive in time" — almost always the GuildMembers
      // privileged intent being disabled, or a slow chunk on a large guild.
      // Skip this run rather than surfacing it as a fatal reconciliation error.
      console.warn(
        `[rankRoleSync-cron] Could not fetch guild members (${err?.message || err}). Skipping this run — ` +
          "if this is not a rate limit, check the GuildMembers privileged intent."
      );
      return;
    }

    // Build discordId -> should-have role set for a fast lookup while sweeping all members.
    const shouldHaveByDiscordId = new Map();
    for (const { discordId, roleIds } of shouldHaveByUserId.values()) {
      shouldHaveByDiscordId.set(discordId, [...roleIds]);
    }

    // Unverified placeholder accounts are left as they are until merged into
    // a real account -- see syncMemberRankRoles in lib/discord/rankRoleSync.mjs.
    const placeholderRows = await queryDb(
      `SELECT discordId FROM users WHERE is_placeholder = 1 AND discordId IS NOT NULL`
    );
    const placeholderDiscordIds = new Set(placeholderRows.map((r) => String(r.discordId)));

    let updated = 0;
    for (const [, member] of guild.members.cache) {
      if (!shouldHaveByDiscordId.has(member.id) && placeholderDiscordIds.has(member.id)) continue;
      const shouldHaveRoleIds = shouldHaveByDiscordId.get(member.id) || [];
      const currentRoleIds = [...member.roles.cache.keys()];
      const { toAdd, toRemove } = diffTrackedRoles(currentRoleIds, shouldHaveRoleIds, trackedRoleIds);

      if (toAdd.length === 0 && toRemove.length === 0) continue;

      try {
        if (toAdd.length) await member.roles.add(toAdd);
        if (toRemove.length) await member.roles.remove(toRemove);
        updated++;
      } catch (err) {
        console.error(`[rankRoleSync-cron] Failed to update roles for ${member.id}:`, err.message);
      }
    }

    console.log(`[rankRoleSync-cron] Reconciliation complete. ${updated} member(s) updated.`);
  } catch (err) {
    console.error("[rankRoleSync-cron] Fatal error during reconciliation:", err);
  }
}

// A slow guild member fetch can outlast the interval; never let two
// reconciliations interleave.
let running = false;
async function reconcileRankDiscordRolesGuarded() {
  if (running) {
    console.warn("[rankRoleSync-cron] Previous reconciliation still running; skipping this tick.");
    return;
  }
  running = true;
  try {
    await reconcileRankDiscordRoles();
  } finally {
    running = false;
  }
}

// Run every 15 minutes
cron.schedule("*/15 * * * *", () => {
  reconcileRankDiscordRolesGuarded();
});

// Also run once on startup (after a short delay to let the DB pool and
// Discord client settle).
setTimeout(() => {
  reconcileRankDiscordRolesGuarded();
}, 15_000);

export { reconcileRankDiscordRoles };
