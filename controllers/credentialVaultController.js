/**
 * controllers/credentialVaultController.js
 *
 * Data access for the Credential Vault. SQL only — no permission decisions and
 * no cryptography here (see services/credentialVaultService.js and
 * lib/credentialVault/*). Raw SQL through the mysql2 pool's promise wrapper,
 * so transactions and affected-row counts are available.
 *
 * Nothing in this file selects users.password_hash except
 * getUserPasswordHashForVerification(), which exists for the challenge-verify
 * path only.
 */

import { GENESIS_HASH, chainHash, sanitiseAuditMetadata, truncateUserAgent } from "../lib/credentialVault/audit.mjs";
import { parseCapabilities, serialiseCapabilities } from "../lib/credentialVault/permissions.mjs";
import { DEFAULT_VAULT_ID } from "../lib/credentialVault/constants.mjs";

// ---------------------------------------------------------------------------
// Connection handling (injectable for tests)
// ---------------------------------------------------------------------------

let injectedPool = null;
let defaultPoolPromise = null;

/** Tests pass a mysql2 promise pool here. */
export function setVaultDatabase(promisePool) {
  injectedPool = promisePool;
}

async function pool() {
  if (injectedPool) return injectedPool;
  if (!defaultPoolPromise) {
    defaultPoolPromise = import("./databaseController.js").then((mod) => mod.default.promise());
  }
  return defaultPoolPromise;
}

async function q(sql, params = [], conn = null) {
  const target = conn || (await pool());
  const [rows] = await target.query(sql, params);
  return rows;
}

/** Run fn(conn) inside a transaction on one connection. */
export async function withTransaction(fn) {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      /* the original error matters more */
    }
    throw error;
  } finally {
    conn.release();
  }
}

function placeholders(list) {
  return list.map(() => "?").join(",");
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Users (identity facts only)
// ---------------------------------------------------------------------------

export async function getUserAccount(userId) {
  const rows = await q(
    `SELECT userId, username, (password_hash IS NOT NULL) AS hasPassword, account_disabled AS accountDisabled
       FROM users WHERE userId = ? LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.userId,
    username: row.username,
    hasPassword: Boolean(Number(row.hasPassword)),
    accountDisabled: Boolean(Number(row.accountDisabled)),
  };
}

/** Only for verifying a reauthentication challenge. Never render or log the result. */
export async function getUserPasswordHashForVerification(userId) {
  const rows = await q(`SELECT password_hash FROM users WHERE userId = ? LIMIT 1`, [userId]);
  return rows[0]?.password_hash || null;
}

export async function getUsernames(userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter((n) => n > 0))];
  if (!ids.length) return new Map();
  const rows = await q(`SELECT userId, username FROM users WHERE userId IN (${placeholders(ids)})`, ids);
  return new Map(rows.map((r) => [r.userId, r.username]));
}

export async function findUserByUsername(username) {
  const rows = await q(`SELECT userId, username FROM users WHERE username = ? AND is_placeholder = 0 LIMIT 1`, [
    String(username || "").trim(),
  ]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getStoredSettings() {
  const rows = await q(`SELECT settingKey, settingValue FROM credentialVaultSettings`);
  return Object.fromEntries(rows.map((r) => [r.settingKey, r.settingValue]));
}

export async function saveSettings(rows, actorUserId) {
  await withTransaction(async (conn) => {
    for (const [key, value] of Object.entries(rows)) {
      await q(
        `INSERT INTO credentialVaultSettings (settingKey, settingValue, updatedBy, updatedAt)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE settingValue = VALUES(settingValue), updatedBy = VALUES(updatedBy), updatedAt = VALUES(updatedAt)`,
        [key, String(value), actorUserId, new Date()],
        conn
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Vault row
// ---------------------------------------------------------------------------

export async function getVault(vaultId = DEFAULT_VAULT_ID) {
  const rows = await q(`SELECT * FROM credentialVaults WHERE vaultId = ?`, [vaultId]);
  return rows[0] || null;
}

/** Set the wrapped fingerprint key only if none exists yet (first writer wins). */
export async function setVaultFingerprintKeyIfMissing(vaultId, kekId, wrapped) {
  const result = await q(
    `UPDATE credentialVaults SET wrappedFingerprintKey = ?, fingerprintKekId = ?
      WHERE vaultId = ? AND wrappedFingerprintKey IS NULL`,
    [wrapped, kekId, vaultId]
  );
  return result.affectedRows === 1;
}

export async function updateVaultFingerprintKey(vaultId, kekId, wrapped, conn = null) {
  await q(`UPDATE credentialVaults SET wrappedFingerprintKey = ?, fingerprintKekId = ? WHERE vaultId = ?`, [wrapped, kekId, vaultId], conn);
}

// ---------------------------------------------------------------------------
// Grants and groups
// ---------------------------------------------------------------------------

function mapGrant(row) {
  return {
    grantId: row.grantId,
    vaultId: row.vaultId,
    scope: row.scope,
    collectionId: row.collectionId,
    credentialId: row.credentialId,
    principalType: row.principalType,
    userId: row.userId,
    groupId: row.groupId,
    effect: row.effect,
    capabilities: parseCapabilities(row.capabilities),
    expiresAt: row.expiresAt,
    reason: row.reason,
    requestId: row.requestId,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

/** Active group ids for a user (membership not expired, group not deleted). */
export async function getActiveGroupIdsForUser(userId, now = new Date()) {
  const rows = await q(
    `SELECT m.groupId FROM credentialGroupMembers m
       JOIN credentialGroups g ON g.groupId = m.groupId AND g.deletedAt IS NULL
      WHERE m.userId = ? AND (m.expiresAt IS NULL OR m.expiresAt > ?)`,
    [userId, now]
  );
  return rows.map((r) => r.groupId);
}

/**
 * Every unrevoked, unexpired grant that applies to the user directly or via an
 * active group membership. Read fresh from the database on every call.
 */
export async function loadGrantsForUser(userId, now = new Date()) {
  const groupIds = await getActiveGroupIdsForUser(userId, now);
  const params = [userId, now];
  let groupClause = "";
  if (groupIds.length) {
    groupClause = ` OR (principalType = 'group' AND groupId IN (${placeholders(groupIds)}))`;
    params.splice(1, 0, ...groupIds);
  }
  const rows = await q(
    `SELECT * FROM credentialGrants
      WHERE revokedAt IS NULL
        AND ((principalType = 'user' AND userId = ?)${groupClause})
        AND (expiresAt IS NULL OR expiresAt > ?)`,
    params
  );
  return { grants: rows.map(mapGrant), groupIds };
}

export async function listGrants({ scope, collectionId = null, credentialId = null, includeRevoked = false }) {
  const where = ["scope = ?"];
  const params = [scope];
  if (scope === "collection") {
    where.push("collectionId = ?");
    params.push(collectionId);
  }
  if (scope === "credential") {
    where.push("credentialId = ?");
    params.push(credentialId);
  }
  if (!includeRevoked) where.push("revokedAt IS NULL");
  const rows = await q(`SELECT * FROM credentialGrants WHERE ${where.join(" AND ")} ORDER BY createdAt DESC`, params);
  return rows.map(mapGrant);
}

export async function listGrantsForPrincipalUser(userId) {
  const rows = await q(`SELECT * FROM credentialGrants WHERE principalType = 'user' AND userId = ? AND revokedAt IS NULL`, [userId]);
  return rows.map(mapGrant);
}

export async function getGrant(grantId) {
  const rows = await q(`SELECT * FROM credentialGrants WHERE grantId = ?`, [grantId]);
  return rows[0] ? mapGrant(rows[0]) : null;
}

export async function insertGrant(grant, actorUserId, conn = null) {
  const result = await q(
    `INSERT INTO credentialGrants
       (vaultId, scope, collectionId, credentialId, principalType, userId, groupId, effect, capabilities,
        expiresAt, reason, requestId, grantedBy, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      grant.vaultId ?? DEFAULT_VAULT_ID,
      grant.scope,
      grant.collectionId ?? null,
      grant.credentialId ?? null,
      grant.principalType,
      grant.userId ?? null,
      grant.groupId ?? null,
      grant.effect ?? "allow",
      serialiseCapabilities(grant.capabilities),
      grant.expiresAt ?? null,
      grant.reason ?? null,
      grant.requestId ?? null,
      actorUserId ?? null,
      new Date(),
    ],
    conn
  );
  return result.insertId;
}

export async function revokeGrant(grantId, actorUserId, reason = "revoked", conn = null) {
  const result = await q(
    `UPDATE credentialGrants SET revokedAt = ?, revokedBy = ?, revokeReason = ? WHERE grantId = ? AND revokedAt IS NULL`,
    [new Date(), actorUserId ?? null, reason, grantId],
    conn
  );
  return result.affectedRows === 1;
}

/** Grants whose expiry has passed but are not yet marked — for the cron sweep. */
export async function listNewlyExpiredGrants(now = new Date()) {
  const rows = await q(
    `SELECT * FROM credentialGrants WHERE revokedAt IS NULL AND expiresAt IS NOT NULL AND expiresAt <= ? LIMIT 500`,
    [now]
  );
  return rows.map(mapGrant);
}

export async function listGroups() {
  const rows = await q(
    `SELECT g.*, (SELECT COUNT(*) FROM credentialGroupMembers m WHERE m.groupId = g.groupId) AS memberCount
       FROM credentialGroups g WHERE g.deletedAt IS NULL ORDER BY g.name`
  );
  return rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) }));
}

export async function getGroup(groupId) {
  const rows = await q(`SELECT * FROM credentialGroups WHERE groupId = ? AND deletedAt IS NULL`, [groupId]);
  return rows[0] || null;
}

export async function createGroup({ name, description }, actorUserId) {
  const result = await q(
    `INSERT INTO credentialGroups (vaultId, name, description, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)`,
    [DEFAULT_VAULT_ID, name, description || null, actorUserId, new Date()]
  );
  return result.insertId;
}

export async function updateGroup(groupId, { name, description }) {
  await q(`UPDATE credentialGroups SET name = ?, description = ? WHERE groupId = ? AND deletedAt IS NULL`, [
    name,
    description || null,
    groupId,
  ]);
}

export async function deleteGroup(groupId, actorUserId) {
  await withTransaction(async (conn) => {
    await q(`UPDATE credentialGroups SET deletedAt = ? WHERE groupId = ?`, [new Date(), groupId], conn);
    await q(
      `UPDATE credentialGrants SET revokedAt = ?, revokedBy = ?, revokeReason = 'group deleted'
        WHERE groupId = ? AND revokedAt IS NULL`,
      [new Date(), actorUserId, groupId],
      conn
    );
    await q(`DELETE FROM credentialGroupMembers WHERE groupId = ?`, [groupId], conn);
  });
}

export async function listGroupMembers(groupId) {
  return q(
    `SELECT m.userId, u.username, m.addedBy, m.addedAt, m.expiresAt
       FROM credentialGroupMembers m JOIN users u ON u.userId = m.userId
      WHERE m.groupId = ? ORDER BY u.username`,
    [groupId]
  );
}

export async function addGroupMember(groupId, userId, actorUserId, expiresAt = null) {
  await q(
    `INSERT INTO credentialGroupMembers (groupId, userId, addedBy, addedAt, expiresAt) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE addedBy = VALUES(addedBy), addedAt = VALUES(addedAt), expiresAt = VALUES(expiresAt)`,
    [groupId, userId, actorUserId, new Date(), expiresAt]
  );
}

export async function removeGroupMember(groupId, userId, conn = null) {
  const result = await q(`DELETE FROM credentialGroupMembers WHERE groupId = ? AND userId = ?`, [groupId, userId], conn);
  return result.affectedRows === 1;
}

export async function listMembershipsForUser(userId) {
  return q(
    `SELECT m.groupId, g.name, m.expiresAt FROM credentialGroupMembers m
       JOIN credentialGroups g ON g.groupId = m.groupId AND g.deletedAt IS NULL WHERE m.userId = ?`,
    [userId]
  );
}

/** Every user id with any vault grant or group membership (for counts and health). */
export async function listUsersWithVaultAccess(now = new Date()) {
  const rows = await q(
    `SELECT userId FROM credentialGrants WHERE principalType = 'user' AND revokedAt IS NULL AND effect = 'allow'
        AND (expiresAt IS NULL OR expiresAt > ?)
     UNION
     SELECT m.userId FROM credentialGroupMembers m JOIN credentialGroups g ON g.groupId = m.groupId AND g.deletedAt IS NULL
      WHERE (m.expiresAt IS NULL OR m.expiresAt > ?)`,
    [now, now]
  );
  return rows.map((r) => r.userId);
}

/** All active allow/deny grants plus all active memberships — for "who can reach this" calculations. */
export async function loadAllActiveGrantsAndMemberships(now = new Date()) {
  const grants = (
    await q(`SELECT * FROM credentialGrants WHERE revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)`, [now])
  ).map(mapGrant);
  const memberships = await q(
    `SELECT m.groupId, m.userId FROM credentialGroupMembers m
       JOIN credentialGroups g ON g.groupId = m.groupId AND g.deletedAt IS NULL
      WHERE (m.expiresAt IS NULL OR m.expiresAt > ?)`,
    [now]
  );
  return { grants, memberships };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export async function listCollections({ includeDeleted = false } = {}) {
  const rows = await q(
    `SELECT c.*, (SELECT COUNT(*) FROM credentials x WHERE x.collectionId = c.collectionId AND x.deletedAt IS NULL) AS credentialCount
       FROM credentialCollections c ${includeDeleted ? "" : "WHERE c.deletedAt IS NULL"} ORDER BY c.name`
  );
  return rows.map((r) => ({ ...r, credentialCount: Number(r.credentialCount), isRequestable: Boolean(r.isRequestable) }));
}

export async function getCollection(collectionId) {
  const rows = await q(`SELECT * FROM credentialCollections WHERE collectionId = ? AND deletedAt IS NULL`, [collectionId]);
  return rows[0] ? { ...rows[0], isRequestable: Boolean(rows[0].isRequestable) } : null;
}

export async function createCollection(input, actorUserId) {
  const now = new Date();
  const result = await q(
    `INSERT INTO credentialCollections (vaultId, name, description, icon, colour, isRequestable, createdBy, updatedBy, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [DEFAULT_VAULT_ID, input.name, input.description, input.icon, input.colour, input.isRequestable ? 1 : 0, actorUserId, actorUserId, now, now]
  );
  return result.insertId;
}

export async function updateCollection(collectionId, input, actorUserId) {
  await q(
    `UPDATE credentialCollections SET name = ?, description = ?, icon = ?, colour = ?, isRequestable = ?, updatedBy = ?, updatedAt = ?
      WHERE collectionId = ? AND deletedAt IS NULL`,
    [input.name, input.description, input.icon, input.colour, input.isRequestable ? 1 : 0, actorUserId, new Date(), collectionId]
  );
}

export async function deleteCollection(collectionId, actorUserId) {
  const rows = await q(`SELECT COUNT(*) AS n FROM credentials WHERE collectionId = ? AND deletedAt IS NULL`, [collectionId]);
  if (Number(rows[0].n) > 0) return { ok: false, error: "Move or delete the credentials in this collection first." };
  await withTransaction(async (conn) => {
    await q(`UPDATE credentialCollections SET deletedAt = ?, updatedBy = ? WHERE collectionId = ?`, [new Date(), actorUserId, collectionId], conn);
    await q(
      `UPDATE credentialGrants SET revokedAt = ?, revokedBy = ?, revokeReason = 'collection deleted'
        WHERE collectionId = ? AND revokedAt IS NULL`,
      [new Date(), actorUserId, collectionId],
      conn
    );
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Credentials (metadata)
// ---------------------------------------------------------------------------

function mapCredential(row) {
  if (!row) return null;
  return {
    credentialId: row.credentialId,
    vaultId: row.vaultId,
    collectionId: row.collectionId,
    type: row.type,
    name: row.name,
    url: row.url,
    username: row.username,
    email: row.email,
    description: row.description,
    details: parseJson(row.details, {}),
    tags: row.tags ? String(row.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
    ownerUserId: row.ownerUserId,
    isRequestable: Boolean(row.isRequestable),
    expiresAt: row.expiresAt,
    rotateEveryDays: row.rotateEveryDays,
    nextRotationAt: row.nextRotationAt,
    lastRotatedAt: row.lastRotatedAt,
    lastReviewedAt: row.lastReviewedAt,
    lastReviewedBy: row.lastReviewedBy,
    currentVersion: row.currentVersion,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Minimal rows for permission filtering: id + collection. */
export async function listCredentialSkeletons({ includeDeleted = false } = {}) {
  return q(
    `SELECT credentialId, collectionId, isRequestable, deletedAt FROM credentials ${includeDeleted ? "" : "WHERE deletedAt IS NULL"}`
  );
}

export async function getCredential(credentialId, { includeDeleted = false } = {}, conn = null) {
  const rows = await q(
    `SELECT * FROM credentials WHERE credentialId = ? ${includeDeleted ? "" : "AND deletedAt IS NULL"} LIMIT 1`,
    [credentialId],
    conn
  );
  return mapCredential(rows[0]);
}

/**
 * Metadata search over an explicit allow-list of credential ids. The caller has
 * already filtered ids by permission; this never widens that set.
 */
export async function searchCredentials(ids, { viewIds = null, q: text = "", type = null, collectionId = null, favouritesOf = null, filter = null, sort = "name", limit = 500, rotationReminderDays = 14 } = {}) {
  if (!ids.length) return [];
  const where = [`c.credentialId IN (${placeholders(ids)})`, "c.deletedAt IS NULL"];
  const params = [...ids];
  if (text) {
    const like = `%${String(text).slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    // Username, email and tags are "view" details: only match them on
    // credentials the caller may view, or a list-only user could recover
    // them one search at a time.
    const detailIds = viewIds === null ? ids : viewIds;
    const detailClause = detailIds.length
      ? ` OR (c.credentialId IN (${placeholders(detailIds)}) AND (c.username LIKE ? OR c.tags LIKE ? OR c.email LIKE ?))`
      : "";
    where.push(`(c.name LIKE ? OR c.url LIKE ? OR col.name LIKE ?${detailClause})`);
    params.push(like, like, like);
    if (detailIds.length) params.push(...detailIds, like, like, like);
  }
  if (type) {
    where.push("c.type = ?");
    params.push(type);
  }
  if (collectionId) {
    where.push("c.collectionId = ?");
    params.push(collectionId);
  }
  let join = "";
  if (favouritesOf) {
    join = "JOIN credentialFavourites f ON f.credentialId = c.credentialId AND f.userId = ?";
    params.unshift(favouritesOf);
  }
  const now = new Date();
  const soon = new Date(now.getTime() + rotationReminderDays * 86400000);
  if (filter === "expiring") {
    where.push("c.expiresAt IS NOT NULL AND c.expiresAt <= ?");
    params.push(soon);
  } else if (filter === "rotation") {
    where.push(
      `((c.nextRotationAt IS NOT NULL AND c.nextRotationAt <= ?) OR EXISTS (SELECT 1 FROM credentialRotationTasks t WHERE t.credentialId = c.credentialId AND t.status = 'open'))`
    );
    params.push(soon);
  } else if (filter === "recent") {
    where.push("c.updatedAt >= ?");
    params.push(new Date(now.getTime() - 14 * 86400000));
  }
  const order = sort === "updated" ? "c.updatedAt DESC" : sort === "type" ? "c.type, c.name" : "c.name";
  const rows = await q(
    `SELECT c.*, col.name AS collectionName, col.colour AS collectionColour, col.icon AS collectionIcon
       FROM credentials c ${join}
       JOIN credentialCollections col ON col.collectionId = c.collectionId
      WHERE ${where.join(" AND ")}
      ORDER BY ${order} LIMIT ${Math.min(Number(limit) || 500, 1000)}`,
    params
  );
  return rows.map((r) => ({
    ...mapCredential(r),
    collectionName: r.collectionName,
    collectionColour: r.collectionColour,
    collectionIcon: r.collectionIcon,
  }));
}

export async function listDeletedCredentials(ids) {
  if (!ids.length) return [];
  const rows = await q(
    `SELECT * FROM credentials WHERE credentialId IN (${placeholders(ids)}) AND deletedAt IS NOT NULL ORDER BY deletedAt DESC LIMIT 200`,
    ids
  );
  return rows.map(mapCredential);
}

/**
 * Insert a credential with its first key and secret version in one
 * transaction. `prepareSecret(credentialId)` is called inside the
 * transaction once the id is known and must return
 * { kekId, wrappedKey, ciphertext, fieldNames, passwordStrength, passwordFingerprint }.
 */
export async function insertCredential(meta, actorUserId, prepareSecret) {
  return withTransaction(async (conn) => {
    const now = new Date();
    const result = await q(
      `INSERT INTO credentials
         (vaultId, collectionId, type, name, url, username, email, description, details, tags, ownerUserId,
          isRequestable, expiresAt, rotateEveryDays, nextRotationAt, lastRotatedAt, currentVersion,
          createdBy, updatedBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        DEFAULT_VAULT_ID,
        meta.collectionId,
        meta.type,
        meta.name,
        meta.url,
        meta.username,
        meta.email,
        meta.description,
        JSON.stringify(meta.details || {}),
        (meta.tags || []).join(","),
        meta.ownerUserId,
        meta.isRequestable ? 1 : 0,
        meta.expiresAt,
        meta.rotateEveryDays,
        meta.nextRotationAt,
        now,
        actorUserId,
        actorUserId,
        now,
        now,
      ],
      conn
    );
    const credentialId = result.insertId;
    const secret = await prepareSecret({ credentialId, vaultId: DEFAULT_VAULT_ID, version: 1 });
    const keyResult = await q(
      `INSERT INTO credentialKeys (credentialId, kekId, wrappedKey, createdAt) VALUES (?, ?, ?, ?)`,
      [credentialId, secret.kekId, secret.wrappedKey, now],
      conn
    );
    await q(
      `INSERT INTO credentialSecretVersions
         (credentialId, version, keyId, ciphertext, fieldNames, changedFields, passwordStrength, passwordFingerprint, createdBy, createdAt)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        credentialId,
        keyResult.insertId,
        secret.ciphertext,
        JSON.stringify(secret.fieldNames),
        JSON.stringify(secret.fieldNames),
        secret.passwordStrength,
        secret.passwordFingerprint,
        actorUserId,
        now,
      ],
      conn
    );
    await q(`UPDATE credentials SET currentVersion = 1 WHERE credentialId = ?`, [credentialId], conn);
    return credentialId;
  });
}

export async function updateCredentialMetadata(credentialId, meta, actorUserId, conn = null) {
  await q(
    `UPDATE credentials SET collectionId = ?, name = ?, url = ?, username = ?, email = ?, description = ?, details = ?,
            tags = ?, ownerUserId = ?, isRequestable = ?, expiresAt = ?, rotateEveryDays = ?, nextRotationAt = ?,
            updatedBy = ?, updatedAt = ?
      WHERE credentialId = ? AND deletedAt IS NULL`,
    [
      meta.collectionId,
      meta.name,
      meta.url,
      meta.username,
      meta.email,
      meta.description,
      JSON.stringify(meta.details || {}),
      (meta.tags || []).join(","),
      meta.ownerUserId,
      meta.isRequestable ? 1 : 0,
      meta.expiresAt,
      meta.rotateEveryDays,
      meta.nextRotationAt,
      actorUserId,
      new Date(),
      credentialId,
    ],
    conn
  );
}

/**
 * Append a new secret version. Locks the credential row so two concurrent
 * saves get consecutive version numbers. `prepare({ credentialId, vaultId,
 * version, currentKey })` returns the same shape as for insertCredential
 * plus optional `keyId` to reuse the current key.
 */
export async function appendSecretVersion(credentialId, actorUserId, prepare, { restoredFromVersion = null, markRotated = false } = {}) {
  return withTransaction(async (conn) => {
    const rows = await q(
      `SELECT credentialId, vaultId, currentVersion, rotateEveryDays FROM credentials WHERE credentialId = ? AND deletedAt IS NULL FOR UPDATE`,
      [credentialId],
      conn
    );
    const cred = rows[0];
    if (!cred) return null;
    const keyRows = await q(
      `SELECT * FROM credentialKeys WHERE credentialId = ? AND retiredAt IS NULL ORDER BY keyId DESC LIMIT 1`,
      [credentialId],
      conn
    );
    const version = Number(cred.currentVersion) + 1;
    const prepared = await prepare({ credentialId, vaultId: cred.vaultId, version, currentKey: keyRows[0] || null });
    let keyId = prepared.keyId;
    const now = new Date();
    if (!keyId) {
      if (keyRows[0]) await q(`UPDATE credentialKeys SET retiredAt = ? WHERE keyId = ?`, [now, keyRows[0].keyId], conn);
      const keyResult = await q(
        `INSERT INTO credentialKeys (credentialId, kekId, wrappedKey, createdAt) VALUES (?, ?, ?, ?)`,
        [credentialId, prepared.kekId, prepared.wrappedKey, now],
        conn
      );
      keyId = keyResult.insertId;
    }
    await q(
      `INSERT INTO credentialSecretVersions
         (credentialId, version, keyId, ciphertext, fieldNames, changedFields, passwordStrength, passwordFingerprint,
          createdBy, createdAt, restoredFromVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        credentialId,
        version,
        keyId,
        prepared.ciphertext,
        JSON.stringify(prepared.fieldNames),
        JSON.stringify(prepared.changedFields || []),
        prepared.passwordStrength,
        prepared.passwordFingerprint,
        actorUserId,
        now,
        restoredFromVersion,
      ],
      conn
    );
    const rotationUpdate = markRotated
      ? `, lastRotatedAt = ?, nextRotationAt = ${cred.rotateEveryDays ? "?" : "nextRotationAt"}`
      : "";
    const params = [version, actorUserId, now];
    if (markRotated) {
      params.push(now);
      if (cred.rotateEveryDays) params.push(new Date(now.getTime() + Number(cred.rotateEveryDays) * 86400000));
    }
    params.push(credentialId);
    await q(`UPDATE credentials SET currentVersion = ?, updatedBy = ?, updatedAt = ?${rotationUpdate} WHERE credentialId = ?`, params, conn);
    return { version };
  });
}

/** Version rows without ciphertext. */
export async function listSecretVersions(credentialId) {
  const rows = await q(
    `SELECT versionId, credentialId, version, fieldNames, changedFields, passwordStrength, createdBy, createdAt, restoredFromVersion
       FROM credentialSecretVersions WHERE credentialId = ? ORDER BY version DESC`,
    [credentialId]
  );
  return rows.map((r) => ({ ...r, fieldNames: parseJson(r.fieldNames, []), changedFields: parseJson(r.changedFields, []) }));
}

/** Current version metadata (no ciphertext). */
export async function getCurrentVersionMeta(credentialId) {
  const rows = await q(
    `SELECT v.versionId, v.version, v.fieldNames, v.passwordStrength FROM credentialSecretVersions v
       JOIN credentials c ON c.credentialId = v.credentialId AND c.currentVersion = v.version
      WHERE v.credentialId = ? LIMIT 1`,
    [credentialId]
  );
  return rows[0] ? { ...rows[0], fieldNames: parseJson(rows[0].fieldNames, []) } : null;
}

/** Ciphertext + wrapped key for one version. versionId null = current version. */
export async function getSecretMaterial(credentialId, versionId = null) {
  const rows = await q(
    `SELECT v.versionId, v.version, v.ciphertext, v.fieldNames, k.keyId, k.kekId, k.wrappedKey, c.vaultId
       FROM credentialSecretVersions v
       JOIN credentials c ON c.credentialId = v.credentialId AND c.deletedAt IS NULL
       JOIN credentialKeys k ON k.keyId = v.keyId
      WHERE v.credentialId = ? AND ${versionId ? "v.versionId = ?" : "v.version = c.currentVersion"} LIMIT 1`,
    versionId ? [credentialId, versionId] : [credentialId]
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, fieldNames: parseJson(row.fieldNames, []) };
}

export async function softDeleteCredential(credentialId, actorUserId) {
  const result = await q(
    `UPDATE credentials SET deletedAt = ?, deletedBy = ? WHERE credentialId = ? AND deletedAt IS NULL`,
    [new Date(), actorUserId, credentialId]
  );
  return result.affectedRows === 1;
}

export async function restoreCredential(credentialId, actorUserId) {
  const result = await q(
    `UPDATE credentials SET deletedAt = NULL, deletedBy = NULL, updatedBy = ?, updatedAt = ? WHERE credentialId = ? AND deletedAt IS NOT NULL`,
    [actorUserId, new Date(), credentialId]
  );
  return result.affectedRows === 1;
}

export async function markReviewed(credentialId, actorUserId) {
  await q(`UPDATE credentials SET lastReviewedAt = ?, lastReviewedBy = ? WHERE credentialId = ?`, [new Date(), actorUserId, credentialId]);
}

// ---------------------------------------------------------------------------
// Key rotation support (admin script)
// ---------------------------------------------------------------------------

export async function listKeysNotWrappedWith(kekId, limit = 200) {
  return q(`SELECT keyId, credentialId, kekId, wrappedKey FROM credentialKeys WHERE kekId <> ? LIMIT ${Number(limit)}`, [kekId]);
}

export async function rewrapKey(keyId, oldKekId, newKekId, wrapped) {
  const result = await q(`UPDATE credentialKeys SET kekId = ?, wrappedKey = ? WHERE keyId = ? AND kekId = ?`, [
    newKekId,
    wrapped,
    keyId,
    oldKekId,
  ]);
  return result.affectedRows === 1;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export async function insertChallenge(challenge) {
  const result = await q(
    `INSERT INTO credentialChallenges
       (tokenHash, userId, sessionHash, credentialId, action, field, versionId, method, status, ip, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      challenge.tokenHash,
      challenge.userId,
      challenge.sessionHash,
      challenge.credentialId,
      challenge.action,
      challenge.field,
      challenge.versionId ?? null,
      challenge.method,
      challenge.ip ?? null,
      challenge.createdAt,
      challenge.expiresAt,
    ]
  );
  return result.insertId;
}

/**
 * Atomically consume a pending, unexpired challenge bound to this user and
 * session. Exactly one caller can win; everyone else gets null. The row is
 * returned only to the winner.
 */
export async function claimChallenge({ tokenHash, userId, sessionHash, now = new Date() }) {
  const result = await q(
    `UPDATE credentialChallenges SET status = 'consumed', consumedAt = ?
      WHERE tokenHash = ? AND status = 'pending' AND expiresAt > ? AND userId = ? AND sessionHash = ?`,
    [now, tokenHash, now, userId, sessionHash]
  );
  if (result.affectedRows !== 1) return null;
  const rows = await q(`SELECT * FROM credentialChallenges WHERE tokenHash = ? LIMIT 1`, [tokenHash]);
  return rows[0] || null;
}

/** Looked up only to give the audit log context on a failed claim. */
export async function peekChallenge(tokenHash) {
  const rows = await q(
    `SELECT challengeId, userId, credentialId, action, field, status, expiresAt FROM credentialChallenges WHERE tokenHash = ? LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

export async function setChallengeOutcome(challengeId, outcome) {
  await q(`UPDATE credentialChallenges SET outcome = ? WHERE challengeId = ?`, [outcome, challengeId]);
}

export async function revokePendingChallenges({ userId = null, credentialId = null }, conn = null) {
  const where = ["status = 'pending'"];
  const params = [];
  if (userId) {
    where.push("userId = ?");
    params.push(userId);
  }
  if (credentialId) {
    where.push("credentialId = ?");
    params.push(credentialId);
  }
  if (params.length === 0) {
    // Revoking every pending challenge is allowed (e.g. a group change) but must be explicit.
  }
  const result = await q(`UPDATE credentialChallenges SET status = 'revoked' WHERE ${where.join(" AND ")}`, params, conn);
  return result.affectedRows;
}

export async function countRecentChallenges(userId, sinceDate) {
  const rows = await q(`SELECT COUNT(*) AS n FROM credentialChallenges WHERE userId = ? AND createdAt >= ?`, [userId, sinceDate]);
  return Number(rows[0].n);
}

export async function purgeOldChallenges(beforeDate) {
  const result = await q(`DELETE FROM credentialChallenges WHERE expiresAt < ?`, [beforeDate]);
  return result.affectedRows;
}

// ---------------------------------------------------------------------------
// Vault passwords and lockout
// ---------------------------------------------------------------------------

export async function getVaultPasswordRow(userId) {
  const rows = await q(`SELECT * FROM credentialVaultPasswords WHERE userId = ?`, [userId]);
  return rows[0] || null;
}

export async function setVaultPasswordVerifier(userId, verifier, { isChange }) {
  const now = new Date();
  await q(
    `INSERT INTO credentialVaultPasswords (userId, verifier, enrolledAt, changedAt, failedAttempts)
     VALUES (?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE verifier = VALUES(verifier), changedAt = VALUES(changedAt),
       enrolledAt = ${isChange ? "enrolledAt" : "VALUES(enrolledAt)"}, failedAttempts = 0, lockedUntil = NULL`,
    [userId, verifier, now, now]
  );
}

export async function clearVaultPasswordVerifier(userId) {
  const result = await q(
    `UPDATE credentialVaultPasswords SET verifier = NULL, changedAt = ?, enrolmentCodeHash = NULL, enrolmentCodeExpiresAt = NULL WHERE userId = ?`,
    [new Date(), userId]
  );
  return result.affectedRows === 1;
}

/**
 * Reserve one verification attempt before checking a password. Atomic: the
 * counter only moves while the user is not locked and below the limit, so
 * parallel guesses cannot exceed `maxAttempts` per lockout window.
 * Returns false when the user is locked (or out of attempts).
 */
export async function reserveVerificationAttempt(userId, maxAttempts, now = new Date(), lockoutMinutes = 15) {
  await q(`INSERT IGNORE INTO credentialVaultPasswords (userId, failedAttempts) VALUES (?, 0)`, [userId]);
  // A counter left at the limit with no lock (an attempt that crashed between
  // reserving and recording) becomes an ordinary, expiring lock rather than a
  // permanent one.
  await q(
    `UPDATE credentialVaultPasswords SET lockedUntil = ?, failedAttempts = 0
      WHERE userId = ? AND failedAttempts >= ? AND (lockedUntil IS NULL OR lockedUntil <= ?)`,
    [new Date(now.getTime() + lockoutMinutes * 60000), userId, maxAttempts, now]
  );
  const result = await q(
    `UPDATE credentialVaultPasswords SET failedAttempts = failedAttempts + 1, lastFailedAt = ?
      WHERE userId = ? AND (lockedUntil IS NULL OR lockedUntil <= ?) AND failedAttempts < ?`,
    [now, userId, now, maxAttempts]
  );
  return result.affectedRows === 1;
}

/**
 * After a failed check: lock the user once the reserved attempts reach the
 * limit. Returns { failedAttempts, lockedUntil }.
 */
export async function lockIfExhausted(userId, maxAttempts, lockoutMinutes, now = new Date()) {
  await q(
    `UPDATE credentialVaultPasswords SET lockedUntil = ?, failedAttempts = 0
      WHERE userId = ? AND failedAttempts >= ?`,
    [new Date(now.getTime() + lockoutMinutes * 60000), userId, maxAttempts]
  );
  const row = await getVaultPasswordRow(userId);
  return { failedAttempts: row?.failedAttempts ?? 0, lockedUntil: row?.lockedUntil ?? null };
}

/** Store a new enrolment code hash (replacing any earlier one). */
export async function setEnrolmentCode(userId, codeHash, expiresAt, issuedBy) {
  await q(
    `INSERT INTO credentialVaultPasswords (userId, enrolmentCodeHash, enrolmentCodeExpiresAt, enrolmentCodeIssuedBy, failedAttempts)
     VALUES (?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE enrolmentCodeHash = VALUES(enrolmentCodeHash),
       enrolmentCodeExpiresAt = VALUES(enrolmentCodeExpiresAt), enrolmentCodeIssuedBy = VALUES(enrolmentCodeIssuedBy)`,
    [userId, codeHash, expiresAt, issuedBy]
  );
}

/** Consume a matching, unexpired enrolment code. Exactly one caller wins. */
export async function consumeEnrolmentCode(userId, codeHash, now = new Date()) {
  const result = await q(
    `UPDATE credentialVaultPasswords SET enrolmentCodeHash = NULL, enrolmentCodeExpiresAt = NULL
      WHERE userId = ? AND enrolmentCodeHash = ? AND enrolmentCodeExpiresAt > ?`,
    [userId, codeHash, now]
  );
  return result.affectedRows === 1;
}

export async function resetFailedVerifications(userId) {
  await q(`UPDATE credentialVaultPasswords SET failedAttempts = 0 WHERE userId = ?`, [userId]);
}

export async function clearLockout(userId) {
  await q(`UPDATE credentialVaultPasswords SET failedAttempts = 0, lockedUntil = NULL WHERE userId = ?`, [userId]);
}

export async function listLockedUsers(now = new Date()) {
  return q(
    `SELECT p.userId, u.username, p.lockedUntil FROM credentialVaultPasswords p JOIN users u ON u.userId = p.userId
      WHERE p.lockedUntil IS NOT NULL AND p.lockedUntil > ?`,
    [now]
  );
}

export async function listVaultPasswordStatus(userIds) {
  const ids = [...new Set(userIds.map(Number).filter((n) => n > 0))];
  if (!ids.length) return [];
  return q(
    `SELECT u.userId, u.username, (u.password_hash IS NOT NULL) AS hasAccountPassword, (p.verifier IS NOT NULL) AS hasVaultPassword,
            p.enrolledAt, p.lockedUntil
       FROM users u LEFT JOIN credentialVaultPasswords p ON p.userId = u.userId
      WHERE u.userId IN (${placeholders(ids)}) ORDER BY u.username`,
    ids
  );
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

export async function listFavouriteIds(userId) {
  const rows = await q(`SELECT credentialId FROM credentialFavourites WHERE userId = ?`, [userId]);
  return new Set(rows.map((r) => r.credentialId));
}

export async function setFavourite(userId, credentialId, on) {
  if (on) {
    await q(`INSERT IGNORE INTO credentialFavourites (userId, credentialId, createdAt) VALUES (?, ?, ?)`, [userId, credentialId, new Date()]);
  } else {
    await q(`DELETE FROM credentialFavourites WHERE userId = ? AND credentialId = ?`, [userId, credentialId]);
  }
}

// ---------------------------------------------------------------------------
// Access requests
// ---------------------------------------------------------------------------

export async function insertAccessRequest(req) {
  const result = await q(
    `INSERT INTO credentialAccessRequests (vaultId, requesterId, scope, collectionId, credentialId, capabilities, reason, durationHours, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      DEFAULT_VAULT_ID,
      req.requesterId,
      req.scope,
      req.collectionId ?? null,
      req.credentialId ?? null,
      serialiseCapabilities(req.capabilities),
      req.reason,
      req.durationHours ?? null,
      new Date(),
    ]
  );
  return result.insertId;
}

function mapRequest(r) {
  return { ...r, capabilities: parseCapabilities(r.capabilities) };
}

export async function getAccessRequest(requestId) {
  const rows = await q(`SELECT * FROM credentialAccessRequests WHERE requestId = ?`, [requestId]);
  return rows[0] ? mapRequest(rows[0]) : null;
}

export async function listAccessRequests({ requesterId = null, status = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (requesterId) {
    where.push("r.requesterId = ?");
    params.push(requesterId);
  }
  if (status) {
    where.push("r.status = ?");
    params.push(status);
  }
  const rows = await q(
    `SELECT r.*, u.username AS requesterName, d.username AS decidedByName
       FROM credentialAccessRequests r
       JOIN users u ON u.userId = r.requesterId
       LEFT JOIN users d ON d.userId = r.decidedBy
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.createdAt DESC LIMIT ${Number(limit)}`,
    params
  );
  return rows.map(mapRequest);
}

/** Move a pending request to a final state. Returns true only for the first decision. */
export async function decideAccessRequest(requestId, { status, decidedBy, note = null, grantId = null }, conn = null) {
  const result = await q(
    `UPDATE credentialAccessRequests SET status = ?, decidedBy = ?, decidedAt = ?, decisionNote = ?, grantId = ?
      WHERE requestId = ? AND status = 'pending'`,
    [status, decidedBy, new Date(), note, grantId, requestId],
    conn
  );
  return result.affectedRows === 1;
}

export async function expireOldRequests(beforeDate) {
  const rows = await q(`SELECT requestId, requesterId FROM credentialAccessRequests WHERE status = 'pending' AND createdAt < ?`, [beforeDate]);
  if (!rows.length) return [];
  await q(`UPDATE credentialAccessRequests SET status = 'expired', decidedAt = ? WHERE status = 'pending' AND createdAt < ?`, [new Date(), beforeDate]);
  return rows;
}

export async function listRequestableTargets() {
  const collections = await q(
    `SELECT collectionId, name, description FROM credentialCollections WHERE deletedAt IS NULL AND isRequestable = 1 ORDER BY name`
  );
  const credentials = await q(
    `SELECT c.credentialId, c.name, c.collectionId, col.name AS collectionName FROM credentials c
       JOIN credentialCollections col ON col.collectionId = c.collectionId AND col.deletedAt IS NULL
      WHERE c.deletedAt IS NULL AND c.isRequestable = 1 ORDER BY c.name`
  );
  return { collections, credentials };
}

// ---------------------------------------------------------------------------
// Rotation tasks
// ---------------------------------------------------------------------------

export async function openRotationTask({ credentialId, reason, details = null, relatedUserId = null, createdBy = null }, conn = null) {
  // One open task per credential + reason: re-running offboarding or the cron
  // must not pile up duplicates.
  const existing = await q(
    `SELECT taskId FROM credentialRotationTasks WHERE credentialId = ? AND reason = ? AND status = 'open'
       AND (relatedUserId <=> ?) LIMIT 1`,
    [credentialId, reason, relatedUserId],
    conn
  );
  if (existing[0]) return { taskId: existing[0].taskId, created: false };
  const result = await q(
    `INSERT INTO credentialRotationTasks (credentialId, reason, details, relatedUserId, status, createdBy, createdAt)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    [credentialId, reason, details, relatedUserId, createdBy, new Date()],
    conn
  );
  return { taskId: result.insertId, created: true };
}

export async function closeRotationTask(taskId, status, actorUserId) {
  const result = await q(
    `UPDATE credentialRotationTasks SET status = ?, completedBy = ?, completedAt = ? WHERE taskId = ? AND status = 'open'`,
    [status, actorUserId, new Date(), taskId]
  );
  return result.affectedRows === 1;
}

export async function closeRotationTasksForCredential(credentialId, actorUserId, conn = null) {
  await q(
    `UPDATE credentialRotationTasks SET status = 'done', completedBy = ?, completedAt = ? WHERE credentialId = ? AND status = 'open'`,
    [actorUserId, new Date(), credentialId],
    conn
  );
}

export async function getRotationTask(taskId) {
  const rows = await q(`SELECT * FROM credentialRotationTasks WHERE taskId = ?`, [taskId]);
  return rows[0] || null;
}

export async function listRotationTasks({ status = "open", credentialIds = null, limit = 500 } = {}) {
  const where = ["t.status = ?", "c.deletedAt IS NULL"];
  const params = [status];
  if (credentialIds) {
    if (!credentialIds.length) return [];
    where.push(`t.credentialId IN (${placeholders(credentialIds)})`);
    params.push(...credentialIds);
  }
  return q(
    `SELECT t.*, c.name AS credentialName, c.collectionId, u.username AS relatedUsername
       FROM credentialRotationTasks t
       JOIN credentials c ON c.credentialId = t.credentialId
       LEFT JOIN users u ON u.userId = t.relatedUserId
      WHERE ${where.join(" AND ")} ORDER BY t.createdAt DESC LIMIT ${Number(limit)}`,
    params
  );
}

export async function listCredentialsDueForRotation(beforeDate) {
  return q(
    `SELECT credentialId, name, nextRotationAt, expiresAt FROM credentials
      WHERE deletedAt IS NULL AND ((nextRotationAt IS NOT NULL AND nextRotationAt <= ?) OR (expiresAt IS NOT NULL AND expiresAt <= ?))`,
    [beforeDate, beforeDate]
  );
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function listHealthRows() {
  const rows = await q(
    `SELECT c.credentialId, c.name, c.type, c.url, c.username, c.collectionId, c.ownerUserId, c.expiresAt, c.nextRotationAt,
            c.lastReviewedAt, c.createdAt, c.updatedAt, v.passwordStrength, v.passwordFingerprint,
            o.username AS ownerName, o.account_disabled AS ownerDisabled,
            (SELECT COUNT(*) FROM credentialRotationTasks t WHERE t.credentialId = c.credentialId AND t.status = 'open') AS openTasks
       FROM credentials c
       LEFT JOIN credentialSecretVersions v ON v.credentialId = c.credentialId AND v.version = c.currentVersion
       LEFT JOIN users o ON o.userId = c.ownerUserId
      WHERE c.deletedAt IS NULL`
  );
  return rows.map((r) => ({ ...r, ownerDisabled: Boolean(Number(r.ownerDisabled)), openTasks: Number(r.openTasks) }));
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append one event to the hash chain. Serialised by locking the single
 * credentialAuditHead row, so concurrent writers cannot fork the chain.
 */
export async function appendAuditEvent(event) {
  const row = {
    occurredAt: event.occurredAt instanceof Date ? event.occurredAt : new Date(),
    eventType: String(event.eventType),
    outcome: event.outcome === "failure" ? "failure" : event.outcome === "denied" ? "denied" : "success",
    actorUserId: event.actorUserId ?? null,
    subjectUserId: event.subjectUserId ?? null,
    credentialId: event.credentialId ?? null,
    collectionId: event.collectionId ?? null,
    sessionHash: event.sessionHash ?? null,
    ip: event.ip ? String(event.ip).slice(0, 45) : null,
    userAgent: truncateUserAgent(event.userAgent),
    metadata: null,
  };
  const meta = sanitiseAuditMetadata(event.metadata);
  row.metadata = meta ? JSON.stringify(meta) : null;
  // Millisecond precision only: DATETIME(3) would round anything finer, which
  // would change the hash on verification.
  row.occurredAt = new Date(Math.floor(row.occurredAt.getTime()));

  return withTransaction(async (conn) => {
    const heads = await q(`SELECT lastHash FROM credentialAuditHead WHERE id = 1 FOR UPDATE`, [], conn);
    const prevHash = heads[0]?.lastHash || GENESIS_HASH;
    const hash = chainHash(prevHash, row);
    const result = await q(
      `INSERT INTO credentialAuditEvents
         (occurredAt, eventType, outcome, actorUserId, subjectUserId, credentialId, collectionId, sessionHash, ip, userAgent, metadata, prevHash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.occurredAt,
        row.eventType,
        row.outcome,
        row.actorUserId,
        row.subjectUserId,
        row.credentialId,
        row.collectionId,
        row.sessionHash,
        row.ip,
        row.userAgent,
        row.metadata,
        prevHash,
        hash,
      ],
      conn
    );
    if (heads[0]) {
      await q(`UPDATE credentialAuditHead SET lastEventId = ?, lastHash = ? WHERE id = 1`, [result.insertId, hash], conn);
    } else {
      await q(`INSERT INTO credentialAuditHead (id, lastEventId, lastHash) VALUES (1, ?, ?)`, [result.insertId, hash], conn);
    }
    return result.insertId;
  });
}

export async function queryAuditEvents({
  actorUserId = null,
  credentialId = null,
  collectionId = null,
  credentialIds = null,
  eventType = null,
  outcome = null,
  from = null,
  to = null,
  limit = 100,
  offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (actorUserId) {
    where.push("(e.actorUserId = ? OR e.subjectUserId = ?)");
    params.push(actorUserId, actorUserId);
  }
  if (credentialId) {
    where.push("e.credentialId = ?");
    params.push(credentialId);
  }
  if (collectionId) {
    where.push("e.collectionId = ?");
    params.push(collectionId);
  }
  if (credentialIds) {
    // Restricts a non-admin auditor to events about credentials they may audit.
    if (!credentialIds.length) return { rows: [], total: 0 };
    where.push(`e.credentialId IN (${placeholders(credentialIds)})`);
    params.push(...credentialIds);
  }
  if (eventType) {
    where.push("e.eventType = ?");
    params.push(eventType);
  }
  if (outcome) {
    where.push("e.outcome = ?");
    params.push(outcome);
  }
  if (from) {
    where.push("e.occurredAt >= ?");
    params.push(from);
  }
  if (to) {
    where.push("e.occurredAt <= ?");
    params.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countRows = await q(`SELECT COUNT(*) AS n FROM credentialAuditEvents e ${whereSql}`, params);
  const rows = await q(
    `SELECT e.eventId, e.occurredAt, e.eventType, e.outcome, e.actorUserId, e.subjectUserId, e.credentialId, e.collectionId,
            e.sessionHash, e.ip, e.userAgent, e.metadata,
            a.username AS actorName, s.username AS subjectName, c.name AS credentialName, col.name AS collectionName
       FROM credentialAuditEvents e
       LEFT JOIN users a ON a.userId = e.actorUserId
       LEFT JOIN users s ON s.userId = e.subjectUserId
       LEFT JOIN credentials c ON c.credentialId = e.credentialId
       LEFT JOIN credentialCollections col ON col.collectionId = e.collectionId
      ${whereSql}
      ORDER BY e.eventId DESC LIMIT ${Math.min(Number(limit) || 100, 500)} OFFSET ${Math.max(Number(offset) || 0, 0)}`,
    params
  );
  return { rows: rows.map((r) => ({ ...r, metadata: parseJson(r.metadata, null) })), total: Number(countRows[0].n) };
}

/** Raw chain rows for verification, in order. */
export async function listAuditChain({ afterEventId = 0, upToEventId = null, limit = 5000 } = {}) {
  return q(
    `SELECT eventId, occurredAt, eventType, outcome, actorUserId, subjectUserId, credentialId, collectionId, sessionHash, ip, userAgent, metadata, prevHash, hash
       FROM credentialAuditEvents WHERE eventId > ? ${upToEventId !== null ? "AND eventId <= ?" : ""} ORDER BY eventId ASC LIMIT ${Number(limit)}`,
    upToEventId !== null ? [afterEventId, upToEventId] : [afterEventId]
  );
}

export async function getAuditHead() {
  const rows = await q(`SELECT lastEventId, lastHash, anchorEventId, anchorHash FROM credentialAuditHead WHERE id = 1`);
  return rows[0] || null;
}

/**
 * Trim events older than `beforeDate`. The anchor (the hash of the newest
 * removed event) is recorded first, so verification knows where the retained
 * chain must start; anything at or below the anchor is ignored.
 */
export async function purgeAuditBefore(beforeDate) {
  const last = await q(
    `SELECT eventId, hash FROM credentialAuditEvents WHERE occurredAt < ? ORDER BY eventId DESC LIMIT 1`,
    [beforeDate]
  );
  if (!last[0]) return 0;
  await q(`UPDATE credentialAuditHead SET anchorEventId = ?, anchorHash = ? WHERE id = 1 AND anchorEventId < ?`, [
    last[0].eventId,
    last[0].hash,
    last[0].eventId,
  ]);
  let removed = 0;
  for (;;) {
    const result = await q(`DELETE FROM credentialAuditEvents WHERE eventId <= ? ORDER BY eventId ASC LIMIT 5000`, [last[0].eventId]);
    removed += result.affectedRows;
    if (result.affectedRows < 5000) break;
  }
  return removed;
}

/** Credentials a user revealed or copied (from the audit trail), for offboarding. */
export async function listCredentialIdsAccessedBy(userId) {
  const rows = await q(
    `SELECT DISTINCT credentialId FROM credentialAuditEvents
      WHERE actorUserId = ? AND credentialId IS NOT NULL AND outcome = 'success'
        AND eventType IN ('secret_revealed', 'secret_copied', 'secret_version_revealed')`,
    [userId]
  );
  return rows.map((r) => r.credentialId);
}

export async function countAuditEventsSince(eventTypes, sinceDate) {
  if (!eventTypes.length) return 0;
  const rows = await q(
    `SELECT COUNT(*) AS n FROM credentialAuditEvents WHERE eventType IN (${placeholders(eventTypes)}) AND occurredAt >= ?`,
    [...eventTypes, sinceDate]
  );
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------
// Admin overview
// ---------------------------------------------------------------------------

export async function getOverviewCounts(now = new Date(), soonDays = 14) {
  const soon = new Date(now.getTime() + soonDays * 86400000);
  const [rows] = [
    await q(
      `SELECT
         (SELECT COUNT(*) FROM credentials WHERE deletedAt IS NULL) AS credentials,
         (SELECT COUNT(*) FROM credentialCollections WHERE deletedAt IS NULL) AS collections,
         (SELECT COUNT(*) FROM credentialRotationTasks t JOIN credentials c ON c.credentialId = t.credentialId AND c.deletedAt IS NULL WHERE t.status = 'open') AS openRotationTasks,
         (SELECT COUNT(*) FROM credentials WHERE deletedAt IS NULL AND expiresAt IS NOT NULL AND expiresAt <= ?) AS expiring,
         (SELECT COUNT(*) FROM credentialAccessRequests WHERE status = 'pending') AS pendingRequests,
         (SELECT COUNT(*) FROM credentials WHERE deletedAt IS NULL AND ownerUserId IS NULL) AS missingOwner`,
      [soon]
    ),
  ];
  const r = rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
