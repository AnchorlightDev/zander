/**
 * lib/servers/serverAccess.mjs
 *
 * Rules for who may join which server on the network.
 *
 * Velocity lets a player onto a server when they hold the LuckPerms node
 * `serverpermissions.server.<velocity server name>` (the hub's server menu
 * checks the same node -- see agent/zander-velocity HubBridgeListener). This
 * module turns "these ranks and these players may join dev" into exactly the
 * LuckPerms console commands that make it so, and nothing else.
 *
 * Every value that ends up in a console command is validated here as a single
 * token, so a crafted form or scheduler payload can never change a command's
 * shape (no spaces, newlines or other arguments slipped in).
 *
 * Imports nothing: unit-testable.
 */

export const NODE_PREFIX = "serverpermissions.server.";

/** Velocity server names: letters, digits, `_`, `-` and `.` only. */
const VELOCITY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** LuckPerms group names (lower-case in LuckPerms, but compared case-insensitively). */
const RANK_NAME = /^[A-Za-z0-9_.-]{1,36}$/;
/** Minecraft Java usernames. */
const USERNAME = /^[A-Za-z0-9_]{1,16}$/;

/** Shortest and longest temporary access the screen accepts. */
export const MIN_TEMP_SECONDS = 60;
export const MAX_TEMP_SECONDS = 366 * 24 * 3600;

export function isValidVelocityName(name) {
  return typeof name === "string" && VELOCITY_NAME.test(name);
}

export function isValidRankName(name) {
  return typeof name === "string" && RANK_NAME.test(name);
}

export function isValidUsername(name) {
  return typeof name === "string" && USERNAME.test(name);
}

/**
 * Clean a submitted Velocity name. Returns null for blank, the trimmed name
 * when valid, or undefined when it is invalid (so callers can tell "cleared"
 * from "rejected").
 */
export function parseVelocityName(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return isValidVelocityName(value) ? value : undefined;
}

/** The LuckPerms node that lets someone onto this server. */
export function accessNode(velocityName) {
  if (!isValidVelocityName(velocityName)) throw new Error("Invalid Velocity server name.");
  // LuckPerms stores nodes in lower case and matches them case-insensitively.
  return `${NODE_PREFIX}${velocityName.toLowerCase()}`;
}

function lower(list) {
  return [...new Set((list || []).map((r) => String(r).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Ranks to grant and revoke, from what LuckPerms holds now and what was ticked.
 * Only ranks that exist (`knownRanks`) are ever touched, so a hand-crafted POST
 * cannot invent a group.
 */
export function diffRanks(current = [], wanted = [], knownRanks = []) {
  const known = new Set(lower(knownRanks));
  const held = new Set(lower(current).filter((r) => known.has(r)));
  const ticked = new Set(lower(wanted).filter((r) => known.has(r) && isValidRankName(r)));
  return {
    grant: [...ticked].filter((r) => !held.has(r)).sort(),
    revoke: [...held].filter((r) => !ticked.has(r)).sort(),
  };
}

/** Commands that give or take a rank's access. Idempotent, so a retried task does no harm. */
export function rankCommands(velocityName, { grant = [], revoke = [] }) {
  const node = accessNode(velocityName);
  const out = [];
  for (const rank of grant) {
    if (!isValidRankName(rank)) throw new Error(`Invalid rank name: ${rank}`);
    out.push(`lp group ${rank.toLowerCase()} permission set ${node} true`);
  }
  for (const rank of revoke) {
    if (!isValidRankName(rank)) throw new Error(`Invalid rank name: ${rank}`);
    out.push(`lp group ${rank.toLowerCase()} permission unset ${node}`);
  }
  return out;
}

/**
 * How long, from `now`, temporary access should last, as a LuckPerms duration.
 * Returns null for permanent access. Throws when the expiry is unusable.
 */
export function tempDuration(expiresAt, now = new Date()) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return null;
  const end = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!Number.isFinite(end.getTime())) throw new Error("That expiry date isn't valid.");
  const seconds = Math.ceil((end.getTime() - now.getTime()) / 1000);
  if (seconds < MIN_TEMP_SECONDS) throw new Error("The expiry must be at least a minute from now.");
  if (seconds > MAX_TEMP_SECONDS) throw new Error("Temporary access can last at most a year. Leave the expiry blank for permanent access.");
  return `${seconds}s`;
}

/**
 * Commands that give one player access, permanently or until `expiresAt`.
 * Any existing grant of the other kind is removed first, so switching between
 * permanent and temporary never leaves both behind.
 */
export function playerGrantCommands(velocityName, username, { expiresAt = null, now = new Date() } = {}) {
  if (!isValidUsername(username)) throw new Error("That isn't a valid Minecraft username.");
  const node = accessNode(velocityName);
  const duration = tempDuration(expiresAt, now);
  if (duration) {
    return [
      `lp user ${username} permission unset ${node}`,
      // "replace" overwrites an existing temporary grant's expiry instead of adding to it.
      `lp user ${username} permission settemp ${node} true ${duration} replace`,
    ];
  }
  return [`lp user ${username} permission unsettemp ${node}`, `lp user ${username} permission set ${node} true`];
}

/** Commands that remove one player's access, whichever kind they hold. */
export function playerRevokeCommands(velocityName, username) {
  if (!isValidUsername(username)) throw new Error("That isn't a valid Minecraft username.");
  const node = accessNode(velocityName);
  return [`lp user ${username} permission unset ${node}`, `lp user ${username} permission unsettemp ${node}`];
}

/**
 * Turn LuckPerms rows for one node into what the screen shows. Rows from
 * luckperms_group_permissions / luckperms_user_permissions:
 *   { name|uuid, username?, value, server, world, expiry, contexts? }
 *
 * Only global grants (no server/world context) are "managed": those are the
 * ones this screen writes and removes. Anything else -- a denial, or a grant
 * limited to a context -- is listed separately and left alone.
 */
export function summariseRows(rows = [], { nowSeconds = Math.floor(Date.now() / 1000), key = "name" } = {}) {
  const managed = [];
  const other = [];
  for (const row of rows) {
    const expiry = Number(row.expiry) || 0;
    if (expiry && expiry <= nowSeconds) continue; // expired; LuckPerms ignores it too
    const isGlobal = (!row.server || row.server === "global") && (!row.world || row.world === "global") && (!row.contexts || row.contexts === "{}");
    const granted = Number(row.value) === 1 || row.value === true;
    const entry = { id: row[key], username: row.username || null, expiresAt: expiry ? new Date(expiry * 1000) : null };
    if (isGlobal && granted) managed.push(entry);
    else other.push({ ...entry, denied: !granted, server: row.server || "global", world: row.world || "global" });
  }
  return { managed, other };
}
