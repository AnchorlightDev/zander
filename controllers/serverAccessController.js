/**
 * controllers/serverAccessController.js
 *
 * Who may join a server: read from LuckPerms, changed through LuckPerms.
 *
 * Reads come straight from the LuckPerms database, so the Access screen shows
 * what is really set (including changes made in game). Writes deliberately do
 * NOT go to that database: LuckPerms caches permissions in memory, so a row
 * written behind its back would look applied here and do nothing on the
 * network. Changes are queued as console commands for zander-addon instead --
 * the same route the rank permissions screen, the webstore and the birthday
 * rank use -- so LuckPerms applies them and pushes them to Velocity itself.
 *
 * The commands themselves are built and validated in lib/servers/serverAccess.mjs.
 */

import db, { luckpermsDb } from "./databaseController.js";
import {
  NODE_PREFIX,
  accessNode,
  diffRanks,
  isValidUsername,
  playerGrantCommands,
  playerRevokeCommands,
  rankCommands,
  summariseRows,
} from "../lib/servers/serverAccess.mjs";

const luckperms = (sql, params = []) =>
  new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });

const main = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });

/** Every LuckPerms group, by name. */
export async function listRanks() {
  const rows = await luckperms(`SELECT name FROM luckperms_groups ORDER BY name ASC`);
  return rows.map((r) => String(r.name));
}

/**
 * What LuckPerms holds for this server's node right now.
 * Returns { node, ranks, players, otherRanks, otherPlayers, wildcardRanks }.
 */
export async function getServerAccess(velocityName) {
  const node = accessNode(velocityName);
  const [groupRows, userRows, wildcardRows] = await Promise.all([
    luckperms(
      `SELECT name, value, server, world, expiry, contexts
         FROM luckperms_group_permissions WHERE permission = ?`,
      [node]
    ),
    luckperms(
      `SELECT up.uuid, pl.username, up.value, up.server, up.world, up.expiry, up.contexts
         FROM luckperms_user_permissions up
         LEFT JOIN luckperms_players pl ON pl.uuid = up.uuid
        WHERE up.permission = ?
        ORDER BY pl.username ASC`,
      [node]
    ),
    // Ranks that reach every server anyway: worth showing, never changed here.
    luckperms(
      `SELECT DISTINCT name, permission FROM luckperms_group_permissions
        WHERE value = 1 AND permission IN ('*', 'serverpermissions.*', ?)`,
      [`${NODE_PREFIX}*`]
    ),
  ]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const groups = summariseRows(groupRows, { nowSeconds, key: "name" });
  const users = summariseRows(userRows, { nowSeconds, key: "uuid" });
  return {
    node,
    ranks: groups.managed.map((g) => String(g.id).toLowerCase()),
    otherRanks: groups.other,
    players: users.managed,
    otherPlayers: users.other,
    wildcardRanks: wildcardRows.map((r) => ({ name: r.name, permission: r.permission })),
  };
}

/** The exact LuckPerms username, or null if this player has never joined. */
export async function findPlayer(username) {
  if (!isValidUsername(String(username || ""))) return null;
  const rows = await luckperms(`SELECT uuid, username FROM luckperms_players WHERE LOWER(username) = LOWER(?) LIMIT 1`, [String(username)]);
  return rows[0] || null;
}

async function queue(commands, metadata) {
  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop
    await main(
      `INSERT INTO executorTasks (slug, command, status, priority, metadata, createdAt, updatedAt)
       VALUES ('any', ?, 'pending', 5, ?, NOW(), NOW())`,
      [command, JSON.stringify(metadata)]
    );
  }
  return commands.length;
}

/**
 * Set which ranks may join. Only the difference from what LuckPerms holds is
 * queued, so saving an untouched form queues nothing.
 * Returns { grant, revoke, queued }.
 */
export async function setRankAccess(velocityName, wantedRanks, actor = null) {
  const [current, known] = await Promise.all([getServerAccess(velocityName), listRanks()]);
  const diff = diffRanks(current.ranks, wantedRanks, known);
  const queued = await queue(rankCommands(velocityName, diff), { source: "serverAccess", server: velocityName, actor });
  return { ...diff, queued };
}

/**
 * Grant or revoke access for ranks without reading the current state first --
 * what the scheduler does (set/unset are idempotent).
 */
export async function changeRankAccess(velocityName, ranks, mode, actor = null) {
  const known = new Set((await listRanks()).map((r) => r.toLowerCase()));
  const wanted = [...new Set((ranks || []).map((r) => String(r).trim().toLowerCase()))];
  const unknown = wanted.filter((r) => !known.has(r));
  if (unknown.length) throw new Error(`Unknown rank${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  const diff = mode === "revoke" ? { grant: [], revoke: wanted } : { grant: wanted, revoke: [] };
  const queued = await queue(rankCommands(velocityName, diff), { source: "serverAccess", server: velocityName, actor });
  return { ...diff, queued };
}

/** Give one player access, permanently or until `expiresAt`. */
export async function grantPlayer(velocityName, username, { expiresAt = null, actor = null } = {}) {
  const player = await findPlayer(username);
  if (!player) throw new Error(`${username} hasn't joined the network yet, so LuckPerms doesn't know them.`);
  const commands = playerGrantCommands(velocityName, player.username, { expiresAt });
  await queue(commands, { source: "serverAccess", server: velocityName, player: player.username, actor });
  return player;
}

/** Take one player's access away. */
export async function revokePlayer(velocityName, username, actor = null) {
  if (!isValidUsername(String(username || ""))) throw new Error("That isn't a valid Minecraft username.");
  await queue(playerRevokeCommands(velocityName, username), { source: "serverAccess", server: velocityName, player: username, actor });
}
