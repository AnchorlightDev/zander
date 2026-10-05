/**
 * controllers/boosterRewardController.js
 *
 * Booster rewards: give linked members who boost the Discord server the
 * configured LuckPerms rank(s), and take them away when the boost ends.
 * The decisions are made in lib/discord/boosterRewards.mjs; this file does the
 * lookups and queues the LuckPerms console commands for the game servers
 * (executorTasks, the same queue the birthday rank uses).
 *
 * Called from:
 *   listeners/boosterRewards.js       -- a member starts or stops boosting
 *   cron/boosterRewardSyncCron.js     -- full sweep every 30 minutes
 *   routes/profileRoutes.js           -- Discord linked or unlinked
 *
 * Raw SQL through the mysql2 pools, matching the other rank controllers.
 */

import { createRequire } from "module";
import db, { luckpermsDb } from "./databaseController.js";
import { client } from "./discordController.js";
import { isSettingsLoaded } from "./configSettingsController.js";
import { buildRankCommand, planBoosterRewards } from "../lib/discord/boosterRewards.mjs";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");

function queryDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}

function queryLuckPermsDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}

const placeholders = (list) => list.map(() => "?").join(", ");

async function loadGrants(discordIds) {
  if (discordIds && discordIds.length === 0) return [];
  return discordIds
    ? queryDb(
        `SELECT userId, discordId, uuid, rankGroup FROM boosterRewardGrants WHERE discordId IN (${placeholders(discordIds)})`,
        discordIds
      )
    : queryDb(`SELECT userId, discordId, uuid, rankGroup FROM boosterRewardGrants`);
}

/** Real linked accounts only: a placeholder has no proven Minecraft identity. */
async function loadLinkedAccounts(discordIds) {
  if (!discordIds.length) return new Map();
  const rows = await queryDb(
    `SELECT userId, uuid, discordId FROM users
      WHERE discordId IN (${placeholders(discordIds)})
        AND is_placeholder = 0
        AND account_disabled = 0
        AND uuid IS NOT NULL`,
    discordIds
  );
  return new Map(rows.map((r) => [String(r.discordId), { userId: r.userId, uuid: r.uuid }]));
}

/**
 * Whether the player already holds the group permanently in LuckPerms. If so
 * the grant is skipped and not recorded, so a boost ending never removes a
 * rank they had anyway (e.g. one they bought).
 */
async function alreadyHoldsGroup(uuid, rankGroup) {
  const rows = await queryLuckPermsDb(
    `SELECT 1 FROM luckperms_user_permissions
      WHERE uuid = ? AND permission = ? AND value = 1
        AND (expiry IS NULL OR expiry = 0)
      LIMIT 1`,
    [uuid, `group.${rankGroup}`]
  );
  return rows.length > 0;
}

async function queueCommand(command, metadata) {
  await queryDb(
    `INSERT INTO executorTasks (slug, command, status, priority, metadata, createdAt, updatedAt)
     VALUES ('any', ?, 'pending', 5, ?, NOW(), NOW())`,
    [command, JSON.stringify({ source: "boosterRewards", ...metadata })]
  );
}

/**
 * Bring grants in line with who is boosting.
 *
 * @param {object} args
 * @param {Set<string>} args.boosterDiscordIds  members currently boosting
 * @param {string[]|null} [args.scope]  limit to these Discord IDs (null = everyone)
 */
export async function syncBoosterRewards({ boosterDiscordIds, scope = null }) {
  // Acting on defaults during a database outage would revoke every grant.
  if (!isSettingsLoaded()) return { skipped: "settings-not-loaded", granted: 0, revoked: 0 };

  const settings = config.discord?.boosterRewards || {};
  const inScope = (id) => !scope || scope.includes(String(id));
  const boosters = new Set([...boosterDiscordIds].map(String).filter(inScope));

  const [grants, linkedByDiscordId] = await Promise.all([
    loadGrants(scope),
    loadLinkedAccounts([...boosters]),
  ]);

  const { toGrant, toRevoke } = planBoosterRewards({
    enabled: settings.enabled === true,
    rankGroups: settings.rankGroups,
    boosterDiscordIds: boosters,
    linkedByDiscordId,
    grants,
  });

  let granted = 0;
  for (const grant of toGrant) {
    try {
      if (await alreadyHoldsGroup(grant.uuid, grant.rankGroup)) continue;
      await queueCommand(buildRankCommand("add", grant.uuid, grant.rankGroup), { action: "grant", ...grant });
      await queryDb(
        `INSERT IGNORE INTO boosterRewardGrants (userId, discordId, uuid, rankGroup) VALUES (?, ?, ?, ?)`,
        [grant.userId, grant.discordId, grant.uuid, grant.rankGroup]
      );
      granted++;
    } catch (error) {
      console.error(`[boosterRewards] Grant ${grant.rankGroup} to userId ${grant.userId} failed:`, error.message);
    }
  }

  let revoked = 0;
  for (const grant of toRevoke) {
    try {
      await queueCommand(buildRankCommand("remove", grant.uuid, grant.rankGroup), { action: "revoke", ...grant });
      await queryDb(`DELETE FROM boosterRewardGrants WHERE userId = ? AND rankGroup = ?`, [grant.userId, grant.rankGroup]);
      revoked++;
    } catch (error) {
      console.error(`[boosterRewards] Revoke ${grant.rankGroup} from userId ${grant.userId} failed:`, error.message);
    }
  }

  if (granted || revoked) {
    console.log(`[boosterRewards] Queued ${granted} grant(s) and ${revoked} revocation(s).`);
  }
  return { granted, revoked };
}

/** Sync one member from a guildMemberUpdate (boost started or ended). */
export async function syncBoosterRewardsForMember(member) {
  if (!member?.id) return null;
  const boosting = Boolean(member.premiumSince);
  return syncBoosterRewards({
    boosterDiscordIds: new Set(boosting ? [member.id] : []),
    scope: [String(member.id)],
  });
}

/**
 * Sync one Discord account by ID, e.g. right after it is linked or unlinked.
 * Someone who is not in the server is not boosting it. Any other lookup
 * failure skips rather than revoking on a guess.
 */
export async function syncBoosterRewardsForDiscordId(discordId) {
  const guildId = config.discord?.guildId;
  if (!discordId || !guildId || !client?.isReady?.()) return null;

  let member = null;
  try {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
    member = await guild.members.fetch(String(discordId));
  } catch (error) {
    if (error?.code !== 10007) {
      console.error(`[boosterRewards] Could not look up Discord member ${discordId}:`, error.message);
      return null;
    }
  }

  return syncBoosterRewards({
    boosterDiscordIds: new Set(member?.premiumSince ? [String(discordId)] : []),
    scope: [String(discordId)],
  });
}
