/**
 * controllers/apiClientController.js
 *
 * Database operations for per-client API credentials, which replace the single
 * app-wide `apiKey` that was shared by every Minecraft plugin, the uptime
 * monitor and this app's own internal calls.  Each client holds an explicit
 * scope list so a compromised or retired caller is revoked on its own.
 *
 * Only the SHA-256 hash of the full key is persisted.  The full key is
 * returned exactly once, at creation, and is never stored or logged.
 *
 * Key format, scope list and path resolution are in lib/apiKeys.js — kept
 * separate so they carry no database import — and re-exported here.
 *
 * Raw SQL through the mysql2 pool, matching the other controllers here.
 */

import db from "./databaseController.js";
import {
  API_SCOPES,
  generateKey,
  hashKey,
  parseKey,
  resolveScope,
  verifyKeyHash,
} from "../lib/apiKeys.js";

export { API_SCOPES, generateKey, hashKey, parseKey, resolveScope, verifyKeyHash };

function queryDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

function normaliseScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes.map(String).filter((s) => API_SCOPES.includes(s)))];
}

/** Parse the stored scopes column, tolerating a malformed row rather than throwing. */
function decodeScopes(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    clientId: row.clientId,
    name: row.name,
    description: row.description,
    keyPrefix: row.keyPrefix,
    keyHash: row.keyHash,
    scopes: decodeScopes(row.scopes),
    isRevoked: row.isRevoked === 1 || row.isRevoked === true,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
    revokedAt: row.revokedAt,
  };
}

/**
 * Create a client and return its full key.  The caller must surface the key
 * immediately — it cannot be recovered afterwards.
 */
export async function createClient({ name, description, scopes, createdByUserId }) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("An API client name is required.");

  const validScopes = normaliseScopes(scopes);
  if (validScopes.length === 0) {
    throw new Error("At least one scope must be selected.");
  }

  const { fullKey, keyPrefix, keyHash } = generateKey();

  const result = await queryDb(
    `INSERT INTO apiClients (name, description, keyPrefix, keyHash, scopes, createdByUserId)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      trimmedName,
      String(description || "").trim() || null,
      keyPrefix,
      keyHash,
      JSON.stringify(validScopes),
      createdByUserId ?? null,
    ]
  );

  invalidateClientCache(keyPrefix);

  return {
    clientId: result.insertId,
    name: trimmedName,
    keyPrefix,
    scopes: validScopes,
    // Returned once. Never persisted, never logged.
    fullKey,
  };
}

export async function listClients() {
  const rows = await queryDb(
    `SELECT * FROM apiClients ORDER BY isRevoked ASC, createdAt DESC`
  );
  return rows.map(mapRow);
}

export async function getClientById(clientId) {
  const rows = await queryDb(`SELECT * FROM apiClients WHERE clientId = ? LIMIT 1`, [
    clientId,
  ]);
  return mapRow(rows[0]);
}

export async function getClientByPrefix(keyPrefix) {
  if (!keyPrefix) return null;
  const rows = await queryDb(`SELECT * FROM apiClients WHERE keyPrefix = ? LIMIT 1`, [
    keyPrefix,
  ]);
  return mapRow(rows[0]);
}

export async function revokeClient(clientId) {
  const existing = await getClientById(clientId);
  await queryDb(
    `UPDATE apiClients SET isRevoked = 1, revokedAt = NOW() WHERE clientId = ?`,
    [clientId]
  );
  // Without this a revoked key keeps working until its cache entry ages out.
  if (existing) invalidateClientCache(existing.keyPrefix);
}

export async function updateScopes(clientId, scopes) {
  const validScopes = normaliseScopes(scopes);
  if (validScopes.length === 0) {
    throw new Error("At least one scope must be selected.");
  }

  const existing = await getClientById(clientId);
  await queryDb(`UPDATE apiClients SET scopes = ? WHERE clientId = ?`, [
    JSON.stringify(validScopes),
    clientId,
  ]);
  if (existing) invalidateClientCache(existing.keyPrefix);

  return validScopes;
}

// ---------------------------------------------------------------------------
// Lookup cache
//
// A polling plugin authenticates on every request; without this each one is a
// database round trip on the hot path.  Revoking or rescoping a client evicts
// its entry immediately, so the TTL only bounds staleness for changes made
// directly in the database.
// ---------------------------------------------------------------------------

const CLIENT_CACHE_TTL_MS = 30_000;
const _clientCache = new Map();

export function invalidateClientCache(keyPrefix) {
  if (keyPrefix) _clientCache.delete(keyPrefix);
  else _clientCache.clear();
}

export async function getClientByPrefixCached(keyPrefix) {
  if (!keyPrefix) return null;

  const now = Date.now();
  const hit = _clientCache.get(keyPrefix);
  if (hit && now < hit.expiresAt) return hit.client;

  const client = await getClientByPrefix(keyPrefix);

  // Only successful lookups are cached. Caching misses would let anyone grow
  // this map without bound by presenting well-formed random prefixes, and
  // nothing sweeps it. Cached on hit only, the map is bounded by the number of
  // real clients.
  if (client) {
    _clientCache.set(keyPrefix, { client, expiresAt: now + CLIENT_CACHE_TTL_MS });
  }

  return client;
}

// ---------------------------------------------------------------------------
// Last-used tracking
// ---------------------------------------------------------------------------

const TOUCH_INTERVAL_MS = 60_000;
const _lastTouch = new Map();

/**
 * Record that a client just authenticated.
 *
 * Fire-and-forget and throttled to one write per client per minute: a plugin
 * polling every few seconds would otherwise turn a read-only auth check into a
 * sustained write load on this table.  Never awaited by the auth path.
 */
export function touchLastUsed(clientId, ip) {
  const now = Date.now();
  const previous = _lastTouch.get(clientId) ?? 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;

  _lastTouch.set(clientId, now);

  queryDb(`UPDATE apiClients SET lastUsedAt = NOW(), lastUsedIp = ? WHERE clientId = ?`, [
    ip ? String(ip).slice(0, 45) : null,
    clientId,
  ]).catch((error) => {
    console.error("[apiClients] failed to record last use:", error?.message ?? error);
  });
}

/** Test seam — clears the touch throttle. */
export function resetTouchThrottle() {
  _lastTouch.clear();
}
