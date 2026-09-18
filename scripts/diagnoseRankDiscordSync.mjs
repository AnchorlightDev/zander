/*
 * Read-only diagnostic: explains why a player's LuckPerms rank did or did not
 * reach Discord.
 *
 * Walks the exact chain syncMemberRankRoles() walks — website account ->
 * LuckPerms player -> group nodes -> meta.discordid role mapping — and prints
 * where it breaks. Makes no changes to any database.
 *
 * Usage:
 *   node scripts/diagnoseRankDiscordSync.mjs <username>
 */
import dotenv from "dotenv";
dotenv.config();

import db, { luckpermsDb } from "../controllers/databaseController.js";

const username = process.argv[2];

function query(pool, sql, params = []) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results || []);
    });
  });
}

const main = async () => {
  if (!username) {
    console.error("Usage: node scripts/diagnoseRankDiscordSync.mjs <username>");
    process.exit(1);
  }

  console.log(`\n=== Rank -> Discord diagnosis for "${username}" ===\n`);

  // 1. Website account(s). username is not unique, so show every row.
  const webUsers = await query(
    db,
    `SELECT userId, username, uuid, discordId, is_placeholder, account_registered,
            SUBSTRING(REPLACE(uuid, '-', ''), 13, 1) AS uuidVersion,
            (SELECT COUNT(*) FROM gameSessions gs WHERE gs.userId = users.userId) AS sessions
       FROM users
      WHERE LOWER(username) = LOWER(?)
      ORDER BY is_placeholder ASC, userId ASC`,
    [username]
  );

  console.log(`[1] users rows matching that username: ${webUsers.length}`);
  for (const u of webUsers) {
    console.log(
      `    userId=${u.userId} uuid=${u.uuid} (v${u.uuidVersion}) discordId=${u.discordId ?? "NONE"} ` +
        `is_placeholder=${u.is_placeholder} registered=${u.account_registered ? "yes" : "no"} sessions=${u.sessions}`
    );
  }
  if (webUsers.length === 0) {
    console.log("    -> No website account. Rank changes can never reach Discord.");
  }
  if (webUsers.length > 1) {
    console.log("    -> DUPLICATE username rows. Whichever one carries the Discord link is the one that matters.");
  }

  // 2. LuckPerms player identity (the authoritative uuid).
  const [lpPlayer] = await query(
    luckpermsDb,
    `SELECT LOWER(uuid) AS uuid, username FROM luckperms_players WHERE LOWER(username) = LOWER(?) LIMIT 1`,
    [username]
  );
  console.log(`\n[2] luckperms_players: ${lpPlayer ? `uuid=${lpPlayer.uuid}` : "NOT FOUND"}`);

  for (const u of webUsers) {
    const matches = lpPlayer && String(u.uuid).toLowerCase() === lpPlayer.uuid;
    console.log(`    userId=${u.userId} uuid ${matches ? "MATCHES" : "DOES NOT MATCH"} the LuckPerms uuid`);
  }
  if (!lpPlayer) {
    console.log("    -> No LuckPerms player. Ranks are unknown; the sync must not touch their roles.");
  }

  // 3. The groups they actually hold, as the sync reads them.
  if (lpPlayer) {
    const nodes = await query(
      luckpermsDb,
      `SELECT permission, server, world, expiry
         FROM luckperms_user_permissions
        WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1
          AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
      [lpPlayer.uuid]
    );
    console.log(`\n[3] Active group nodes: ${nodes.length}`);
    for (const n of nodes) {
      console.log(`    ${n.permission}  (server=${n.server} world=${n.world} expiry=${n.expiry})`);
    }

    // 4. Which of those ranks map to a Discord role.
    const roleRows = await query(
      luckpermsDb,
      `SELECT name AS rankSlug, SUBSTRING_INDEX(permission, '.', -1) AS discordRoleId
         FROM luckperms_group_permissions
        WHERE permission LIKE 'meta.discordid.%' AND value = 1
          AND server = 'global' AND world = 'global'`
    );
    const roleMap = new Map(roleRows.map((r) => [r.rankSlug, String(r.discordRoleId)]));

    console.log(`\n[4] Ranks with a meta.discordid configured: ${roleMap.size}`);
    for (const [slug, roleId] of roleMap) console.log(`    ${slug} -> ${roleId}`);

    const held = nodes.map((n) => n.permission.slice("group.".length));
    const shouldHave = held.map((s) => roleMap.get(s)).filter(Boolean);
    console.log(`\n[5] Roles they should hold in Discord: ${shouldHave.length ? shouldHave.join(", ") : "NONE"}`);

    const unmapped = held.filter((s) => !roleMap.has(s));
    if (unmapped.length) {
      console.log(`    Ranks held with NO Discord role configured: ${unmapped.join(", ")}`);
    }
  }

  console.log(
    "\nIf [5] lists roles but Discord still shows none, the remaining causes are outside the database: " +
      "the account is not in the guild, or the bot lacks Manage Roles / its highest role sits below the rank roles.\n"
  );
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[rank-sync-diagnosis] Fatal error:", error);
    process.exit(1);
  });
