/**
 * Nickname service.
 *
 * Every rule lives in the function that performs the work: permission (holds
 * zander.nickname), punishment (muted/banned in LiteBans), staff lockout, the
 * 24h cooldown, content validation, impersonation, the 14-day reservation hold
 * and effective-nickname resolution. Nothing is left to the caller. Every
 * nickname change and every staff action is audit-logged via generateLog.
 *
 * The proxy/plugins never touch the database: they call the HTTP API
 * (api/routes/nickname.js), which calls into here.
 *
 * Data access is bundled into `realDeps` (lazy DB imports, so importing this
 * module opens no pools), and each public function takes a `deps` argument that
 * defaults to it, so the orchestration is testable with fakes.
 */

import { createRequire } from "module";
import { hasPermission } from "../lib/discord/permissions.mjs";
import {
  validateNicknameContent,
  messageForCode,
  buildSkeleton,
  NICKNAME_COLORS,
} from "../lib/nicknames/nicknameValidation.mjs";
import {
  cooldownRemainingMs,
  cooldownEndsAt,
  reservationExpiry,
  resolveEffectiveNickname,
  checkImpersonation,
} from "../lib/nicknames/nicknamePolicy.mjs";

const require = createRequire(import.meta.url);

export const PERMISSION_NICKNAME = "zander.nickname";
export const PERMISSION_COLOR = "zander.nickname.color";
export const PERMISSION_MANAGE = "zander.nickname.manage";

export { NICKNAME_COLORS };

// ---------------------------------------------------------------------------
// Lazy data access (so importing this module never opens a connection pool).
// ---------------------------------------------------------------------------

let _dbMod = null;
async function dbMod() {
  if (!_dbMod) _dbMod = await import("./databaseController.js");
  return _dbMod;
}
async function mainQuery(sql, params = []) {
  const { default: db } = await dbMod();
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}
async function lpQuery(sql, params = []) {
  const { luckpermsDb } = await dbMod();
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}
async function punQuery(sql, params = []) {
  const { punishmentsDb } = await dbMod();
  return new Promise((resolve, reject) => {
    punishmentsDb.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}

let _userController = null;
async function getUserPermissionsReal(identity) {
  if (!_userController) _userController = await import("./userController.js");
  return _userController.getUserPermissions(identity);
}
let _common = null;
async function generateLogReal(userId, logType, logFeature, description) {
  if (!_common) _common = await import("../api/common.js");
  return _common.generateLog(userId, logType, logFeature, description);
}

function liveConfig() {
  // config.cjs is the shared, live settings object (see CLAUDE.md Config layering).
  return require("../lib/config/config.cjs");
}

function normUuid(uuid) {
  return String(uuid || "").replace(/-/g, "").toLowerCase();
}

// ---- cached reference sets (usernames + staff), short TTL ------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
let _usernameIndex = { at: 0, bySkeleton: new Map() };
let _staffSkeletons = { at: 0, list: [] };

async function usernameIndex(now = Date.now()) {
  if (now - _usernameIndex.at < CACHE_TTL_MS && _usernameIndex.bySkeleton.size) {
    return _usernameIndex.bySkeleton;
  }
  const rows = await mainQuery(`SELECT userId, username FROM users WHERE username IS NOT NULL`);
  const map = new Map();
  for (const { userId, username } of rows) {
    const sk = buildSkeleton(username);
    if (!sk) continue;
    const owners = map.get(sk);
    if (owners) owners.push(userId);
    else map.set(sk, [userId]);
  }
  _usernameIndex = { at: now, bySkeleton: map };
  return map;
}

async function staffSkeletons(now = Date.now()) {
  if (now - _staffSkeletons.at < CACHE_TTL_MS && _staffSkeletons.list.length) {
    return _staffSkeletons.list;
  }
  const groups = (liveConfig().compass?.staffGroups || [])
    .map((g) => `group.${String(g).trim().toLowerCase()}`)
    .filter((g) => g !== "group.");
  if (!groups.length) {
    _staffSkeletons = { at: now, list: [] };
    return [];
  }
  const placeholders = groups.map(() => "?").join(", ");
  // Global, active staff-group grants -> staff UUIDs.
  const staffRows = await lpQuery(
    `SELECT DISTINCT uuid FROM luckperms_user_permissions
      WHERE permission IN (${placeholders})
        AND value = 1
        AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())
        AND server = 'global' AND world = 'global'`,
    groups
  );
  const uuids = staffRows.map((r) => r.uuid).filter(Boolean);
  const skeletons = new Set();
  if (uuids.length) {
    const ph = uuids.map(() => "?").join(", ");
    const users = await mainQuery(
      `SELECT userId, username FROM users WHERE uuid IN (${ph})`,
      uuids
    );
    const userIds = [];
    for (const u of users) {
      if (u.username) skeletons.add(buildSkeleton(u.username));
      userIds.push(u.userId);
    }
    if (userIds.length) {
      const ph2 = userIds.map(() => "?").join(", ");
      const nicks = await mainQuery(
        `SELECT nickname FROM nicknames WHERE userId IN (${ph2}) AND nickname IS NOT NULL`,
        userIds
      );
      for (const n of nicks) if (n.nickname) skeletons.add(buildSkeleton(n.nickname));
    }
  }
  _staffSkeletons = { at: now, list: Array.from(skeletons).filter(Boolean) };
  return _staffSkeletons.list;
}

/** Test seam: drop the reference caches. */
export function _clearCaches() {
  _usernameIndex = { at: 0, bySkeleton: new Map() };
  _staffSkeletons = { at: 0, list: [] };
  _blocklistCache = { at: 0, value: null };
}

// ---- blocklist (cached) ----------------------------------------------------

let _blocklistCache = { at: 0, value: null };
async function getBlocklistReal(now = Date.now()) {
  if (_blocklistCache.value && now - _blocklistCache.at < CACHE_TTL_MS) {
    return _blocklistCache.value;
  }
  const rows = await mainQuery(`SELECT entryType, value FROM nicknameBlocklist`);
  const bannedWords = [];
  const rankWords = [];
  for (const { entryType, value } of rows) {
    if (entryType === "rank") rankWords.push(value);
    else bannedWords.push(value);
  }
  const value = { bannedWords, rankWords };
  _blocklistCache = { at: now, value };
  return value;
}

// ---- individual data accessors --------------------------------------------

async function getNicknameRowReal(userId) {
  const rows = await mainQuery(
    `SELECT nicknameId, userId, nickname, skeleton, color, setAt, lastChangeAt
       FROM nicknames WHERE userId = ? LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function isPunishedReal(uuid) {
  const n = normUuid(uuid);
  if (!n) return false;
  const now = Date.now();
  const rows = await punQuery(
    `SELECT 1 AS hit FROM litebans_bans
       WHERE REPLACE(uuid,'-','') = ? AND active = 1 AND (until = 0 OR until > ?) LIMIT 1
     UNION ALL
     SELECT 1 AS hit FROM litebans_mutes
       WHERE REPLACE(uuid,'-','') = ? AND active = 1 AND (until = 0 OR until > ?) LIMIT 1`,
    [n, now, n, now]
  );
  return rows.length > 0;
}

async function getLockoutReal(userId) {
  const rows = await mainQuery(
    `SELECT lockoutId, reason, expiresAt FROM nicknameLockouts
      WHERE userId = ? AND (expiresAt IS NULL OR expiresAt > NOW()) LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function getReferenceReal({ userId, username, skeleton, now = Date.now() }) {
  const [usernames, staff, nickRows, resRows] = await Promise.all([
    usernameIndex(now),
    staffSkeletons(now),
    mainQuery(`SELECT userId FROM nicknames WHERE skeleton = ?`, [skeleton]),
    mainQuery(
      `SELECT userId FROM nicknameReservations WHERE skeleton = ? AND reservedUntil > NOW()`,
      [skeleton]
    ),
  ]);
  const nickOwners = new Map();
  const owners = [...nickRows, ...resRows].map((r) => r.userId);
  if (owners.length) nickOwners.set(skeleton, owners);
  return {
    ownUsernameSkeleton: buildSkeleton(username),
    usernameOwners: usernames,
    nicknameOwners: nickOwners,
    staffSkeletons: staff,
  };
}

async function persistSetReal({ userId, nickname, skeleton, color, now, previous }) {
  const nowDate = new Date(now);
  if (previous && previous.nickname) {
    // Hold the replaced name for 14 days and close its open history entry.
    await mainQuery(
      `INSERT INTO nicknameReservations (userId, nickname, skeleton, reservedUntil)
       VALUES (?, ?, ?, ?)`,
      [userId, previous.nickname, previous.skeleton, reservationExpiry(now)]
    );
    await mainQuery(
      `UPDATE nicknameHistory SET clearedAt = ?, clearedBy = ?, reason = 'changed'
        WHERE userId = ? AND clearedAt IS NULL`,
      [nowDate, userId, userId]
    );
  }
  // Reclaiming: drop any of this user's own reservations for the new name.
  await mainQuery(`DELETE FROM nicknameReservations WHERE userId = ? AND skeleton = ?`, [
    userId,
    skeleton,
  ]);
  await mainQuery(
    `INSERT INTO nicknames (userId, nickname, skeleton, color, setAt, lastChangeAt)
       VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       nickname = VALUES(nickname), skeleton = VALUES(skeleton), color = VALUES(color),
       setAt = VALUES(setAt), lastChangeAt = VALUES(lastChangeAt)`,
    [userId, nickname, skeleton, color, nowDate, nowDate]
  );
  await mainQuery(
    `INSERT INTO nicknameHistory (userId, nickname, color, setAt) VALUES (?, ?, ?, ?)`,
    [userId, nickname, color, nowDate]
  );
}

async function persistClearReal({ userId, actorUserId, byStaff, now, previous }) {
  const nowDate = new Date(now);
  if (previous && previous.nickname) {
    if (!byStaff) {
      // Self-clear holds the name for 14 days so nobody can grab it.
      await mainQuery(
        `INSERT INTO nicknameReservations (userId, nickname, skeleton, reservedUntil)
         VALUES (?, ?, ?, ?)`,
        [userId, previous.nickname, previous.skeleton, reservationExpiry(now)]
      );
    }
    await mainQuery(
      `UPDATE nicknameHistory SET clearedAt = ?, clearedBy = ?, reason = ?
        WHERE userId = ? AND clearedAt IS NULL`,
      [nowDate, actorUserId, byStaff ? "staff reset" : "cleared", userId]
    );
  }
  // Keep the row (and, for self-clears, its lastChangeAt) so the cooldown
  // survives. A staff reset wipes lastChangeAt so the player is not penalised.
  if (byStaff) {
    await mainQuery(
      `UPDATE nicknames SET nickname = NULL, skeleton = NULL, color = NULL,
         setAt = NULL, lastChangeAt = NULL WHERE userId = ?`,
      [userId]
    );
  } else {
    await mainQuery(
      `UPDATE nicknames SET nickname = NULL, skeleton = NULL, color = NULL, setAt = NULL
        WHERE userId = ?`,
      [userId]
    );
  }
}

export const realDeps = {
  now: () => Date.now(),
  resolveUser: (identity) => resolveUser(identity),
  getPermissions: getUserPermissionsReal,
  isPunished: isPunishedReal,
  getLockout: getLockoutReal,
  getNicknameRow: getNicknameRowReal,
  getBlocklist: getBlocklistReal,
  getReference: getReferenceReal,
  persistSet: persistSetReal,
  persistClear: persistClearReal,
  log: generateLogReal,
};

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/** Resolve a { userId, uuid, username } record from any of those. */
export async function resolveUser(identity = {}) {
  if (identity.userId && identity.uuid && identity.username) return identity;
  let where = null;
  let param = null;
  if (identity.userId) {
    where = "userId = ?";
    param = identity.userId;
  } else if (identity.uuid) {
    where = "REPLACE(uuid,'-','') = ?";
    param = normUuid(identity.uuid);
  } else if (identity.username) {
    where = "LOWER(username) = LOWER(?)";
    param = identity.username;
  } else {
    return null;
  }
  const rows = await mainQuery(
    `SELECT userId, uuid, username FROM users WHERE ${where} LIMIT 1`,
    [param]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

async function permissionFlags(identity, deps) {
  const perms = (await deps.getPermissions(identity)) || [];
  return {
    perms,
    nickname: hasPermission(perms, PERMISSION_NICKNAME),
    color: hasPermission(perms, PERMISSION_COLOR),
    manage: hasPermission(perms, PERMISSION_MANAGE),
  };
}

export async function holdsNicknamePermission(identity, deps = realDeps) {
  return (await permissionFlags(identity, deps)).nickname;
}

// ---------------------------------------------------------------------------
// Resolution (display)
// ---------------------------------------------------------------------------

/**
 * Effective nickname for a player: the stored nickname only while they hold the
 * permission, otherwise their real username.
 */
export async function resolveNickname(identity, deps = realDeps) {
  const user = await deps.resolveUser(identity);
  if (!user) return null;
  const [flags, row] = await Promise.all([
    permissionFlags(user, deps),
    deps.getNicknameRow(user.userId),
  ]);
  return {
    userId: user.userId,
    uuid: user.uuid,
    ...resolveEffectiveNickname({
      username: user.username,
      nicknameRow: row,
      holdsPermission: flags.nickname,
    }),
  };
}

/**
 * Real username behind a currently-displayed nickname. Only resolves nicknames
 * whose owner currently holds the permission (a hidden nickname is not shown, so
 * /realname must not reveal it).
 */
export async function resolveRealName(displayed, deps = realDeps) {
  const value = String(displayed || "").replace(/^~/, "").trim();
  if (!value) return null;
  const rows = await mainQuery(
    `SELECT u.userId, u.uuid, u.username
       FROM nicknames n JOIN users u ON u.userId = n.userId
      WHERE LOWER(n.nickname) = LOWER(?) LIMIT 5`,
    [value]
  );
  for (const row of rows) {
    if (await holdsNicknamePermission(row, deps)) {
      return { userId: row.userId, uuid: row.uuid, username: row.username, nickname: value };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

function fail(code, extra = {}) {
  return { ok: false, code, message: messageForCode(code), ...extra };
}

/** Set (or change) the caller's own nickname. Enforces every rule itself. */
export async function setNickname(identity, { name, color = null } = {}, deps = realDeps) {
  const user = await deps.resolveUser(identity);
  if (!user) return fail("unknown_user");
  const now = deps.now();

  const flags = await permissionFlags(user, deps);
  if (!flags.nickname) return fail("no_permission");

  const lockout = await deps.getLockout(user.userId);
  if (lockout) {
    return fail("locked", {
      reason: lockout.reason || null,
      expiresAt: lockout.expiresAt || null,
    });
  }

  if (await deps.isPunished(user.uuid)) return fail("punished");

  const { bannedWords, rankWords } = await deps.getBlocklist(now);
  const content = validateNicknameContent({ name, color, rankWords, bannedWords });
  if (!content.ok) return content;

  if (content.color && !flags.color) return fail("color_not_allowed");

  const row = await deps.getNicknameRow(user.userId);

  // Identical to the current nickname+colour: a no-op, not a cooldown-consuming change.
  if (row && row.nickname === content.value && (row.color || null) === (content.color || null)) {
    return { ok: true, nickname: content.value, color: content.color, unchanged: true };
  }

  const remaining = cooldownRemainingMs(row?.lastChangeAt, now);
  if (remaining > 0) {
    return fail("cooldown", { retryAt: cooldownEndsAt(row?.lastChangeAt, now), remainingMs: remaining });
  }

  const ref = await deps.getReference({
    userId: user.userId,
    username: user.username,
    skeleton: content.skeleton,
    now,
  });
  const imp = checkImpersonation({
    skeleton: content.skeleton,
    ownUserId: user.userId,
    ownUsernameSkeleton: ref.ownUsernameSkeleton,
    usernameOwners: ref.usernameOwners,
    nicknameOwners: ref.nicknameOwners,
    staffSkeletons: ref.staffSkeletons,
  });
  if (!imp.ok) return fail(imp.code);

  await deps.persistSet({
    userId: user.userId,
    nickname: content.value,
    skeleton: content.skeleton,
    color: content.color,
    now,
    previous: row,
  });
  await deps.log(
    user.userId,
    "NICKNAME_SET",
    "nickname",
    `${user.username} (userId=${user.userId}) set nickname "${content.value}"${
      content.color ? ` [${content.color}]` : ""
    }`
  );

  return { ok: true, nickname: content.value, color: content.color };
}

/** Clear the caller's own nickname. Allowed even while punished or lapsed. */
export async function clearNickname(identity, deps = realDeps) {
  const user = await deps.resolveUser(identity);
  if (!user) return fail("unknown_user");
  const now = deps.now();
  const row = await deps.getNicknameRow(user.userId);
  if (!row || !row.nickname) return { ok: true, cleared: false };

  await deps.persistClear({ userId: user.userId, actorUserId: user.userId, byStaff: false, now, previous: row });
  await deps.log(
    user.userId,
    "NICKNAME_CLEARED",
    "nickname",
    `${user.username} (userId=${user.userId}) cleared nickname "${row.nickname}"`
  );
  return { ok: true, cleared: true };
}

// ---------------------------------------------------------------------------
// Staff actions (zander.nickname.manage). Each is audit-logged.
// ---------------------------------------------------------------------------

/** Reset a player's nickname. No 14-day hold and no cooldown penalty. */
export async function staffResetNickname(targetIdentity, actorUserId, deps = realDeps) {
  const user = await deps.resolveUser(targetIdentity);
  if (!user) return fail("unknown_user");
  const now = deps.now();
  const row = await deps.getNicknameRow(user.userId);
  if (!row || !row.nickname) return { ok: true, cleared: false };

  await deps.persistClear({ userId: user.userId, actorUserId, byStaff: true, now, previous: row });
  await deps.log(
    actorUserId,
    "NICKNAME_RESET",
    "nickname",
    `Reset nickname "${row.nickname}" for ${user.username} (userId=${user.userId})`
  );
  return { ok: true, cleared: true, previous: row.nickname, target: user };
}

export async function staffLock(targetIdentity, { reason = null, expiresAt = null }, actorUserId, deps = realDeps) {
  const user = await deps.resolveUser(targetIdentity);
  if (!user) return fail("unknown_user");
  await mainQuery(
    `INSERT INTO nicknameLockouts (userId, reason, lockedBy, expiresAt)
       VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), lockedBy = VALUES(lockedBy),
       expiresAt = VALUES(expiresAt), createdAt = CURRENT_TIMESTAMP`,
    [user.userId, reason, actorUserId, expiresAt ? new Date(expiresAt) : null]
  );
  await deps.log(
    actorUserId,
    "NICKNAME_LOCKED",
    "nickname",
    `Locked ${user.username} (userId=${user.userId}) out of nicknames${reason ? `: ${reason}` : ""}${
      expiresAt ? ` until ${new Date(expiresAt).toISOString()}` : ""
    }`
  );
  return { ok: true, target: user };
}

export async function staffUnlock(targetIdentity, actorUserId, deps = realDeps) {
  const user = await deps.resolveUser(targetIdentity);
  if (!user) return fail("unknown_user");
  await mainQuery(`DELETE FROM nicknameLockouts WHERE userId = ?`, [user.userId]);
  await deps.log(
    actorUserId,
    "NICKNAME_UNLOCKED",
    "nickname",
    `Unlocked ${user.username} (userId=${user.userId}) for nicknames`
  );
  return { ok: true, target: user };
}

/**
 * Release a reserved or hidden nickname. A reservationId releases a 14-day hold;
 * a targetIdentity releases a user's stored (incl. hidden) nickname.
 */
export async function staffRelease({ reservationId = null, targetIdentity = null }, actorUserId, deps = realDeps) {
  if (reservationId) {
    const rows = await mainQuery(
      `SELECT reservationId, userId, nickname FROM nicknameReservations WHERE reservationId = ? LIMIT 1`,
      [reservationId]
    );
    if (!rows.length) return fail("not_found");
    await mainQuery(`DELETE FROM nicknameReservations WHERE reservationId = ?`, [reservationId]);
    await deps.log(
      actorUserId,
      "NICKNAME_RELEASED",
      "nickname",
      `Released reserved nickname "${rows[0].nickname}" (reservationId=${reservationId})`
    );
    return { ok: true, released: rows[0].nickname };
  }
  const user = await deps.resolveUser(targetIdentity || {});
  if (!user) return fail("unknown_user");
  const now = deps.now();
  const row = await deps.getNicknameRow(user.userId);
  if (!row || !row.nickname) return { ok: true, released: null };
  // Staff release of a held/hidden nickname: drop it without a new hold.
  await deps.persistClear({ userId: user.userId, actorUserId, byStaff: true, now, previous: row });
  await deps.log(
    actorUserId,
    "NICKNAME_RELEASED",
    "nickname",
    `Released nickname "${row.nickname}" held by ${user.username} (userId=${user.userId})`
  );
  return { ok: true, released: row.nickname, target: user };
}

export async function getNicknameHistory(targetIdentity) {
  const user = await resolveUser(targetIdentity);
  if (!user) return null;
  const rows = await mainQuery(
    `SELECT historyId, nickname, color, setAt, clearedAt, clearedBy, reason
       FROM nicknameHistory WHERE userId = ? ORDER BY setAt DESC, historyId DESC`,
    [user.userId]
  );
  return { user, history: rows };
}

// ---- blocklist editors -----------------------------------------------------

export async function listBlocklist() {
  const rows = await mainQuery(
    `SELECT entryId, entryType, value, addedBy, createdAt FROM nicknameBlocklist ORDER BY entryType, value`
  );
  return rows;
}

export async function addBlocklistEntry(entryType, value, actorUserId) {
  const type = entryType === "rank" ? "rank" : "word";
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return fail("empty");
  await mainQuery(
    `INSERT IGNORE INTO nicknameBlocklist (entryType, value, addedBy) VALUES (?, ?, ?)`,
    [type, clean, actorUserId]
  );
  _blocklistCache = { at: 0, value: null };
  await generateLogReal(actorUserId, "NICKNAME_BLOCKLIST_ADD", "nickname", `Added ${type} "${clean}" to the nickname blocklist`);
  return { ok: true };
}

export async function removeBlocklistEntry(entryId, actorUserId) {
  const rows = await mainQuery(`SELECT entryType, value FROM nicknameBlocklist WHERE entryId = ? LIMIT 1`, [entryId]);
  if (!rows.length) return fail("not_found");
  await mainQuery(`DELETE FROM nicknameBlocklist WHERE entryId = ?`, [entryId]);
  _blocklistCache = { at: 0, value: null };
  await generateLogReal(
    actorUserId,
    "NICKNAME_BLOCKLIST_REMOVE",
    "nickname",
    `Removed ${rows[0].entryType} "${rows[0].value}" from the nickname blocklist`
  );
  return { ok: true };
}
