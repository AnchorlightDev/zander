/**
 * lib/sessionCache.mjs
 *
 * A short-lived in-memory copy of session data in front of the database
 * session store (lib/fastifyPrismaSessionStore.js).
 *
 * Why: the session table lives on a database that is sometimes slow. The store
 * gives up on a read after a few seconds, and a read that gives up makes that
 * one request look logged out -- a dashboard action fails with "no token", or
 * a page renders as a visitor. With this cache:
 *
 *   - a read within `ttlMs` of the last read/write is answered from memory;
 *   - if the database times out, the last known copy (up to `staleMs` old) is
 *     used instead of treating the person as logged out.
 *
 * Neither ever outlives the session's own expiry. The trade-off is accepted:
 * a logout or permission change made on another instance can take up to
 * `ttlMs` to be seen here (longer only while the database is not answering).
 * Changes made on this instance apply immediately.
 *
 * Pure (injectable clock), so it is unit-testable.
 */

export class SessionCache {
  /**
   * @param {{ ttlMs?: number, staleMs?: number, maxEntries?: number, now?: () => number }} [opts]
   */
  constructor({ ttlMs = 60_000, staleMs = 15 * 60_000, maxEntries = 10_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.staleMs = staleMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  #lookup(sid, maxAgeMs) {
    const entry = this.entries.get(sid);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.sessionExpiresAt && now >= entry.sessionExpiresAt) {
      this.entries.delete(sid);
      return undefined;
    }
    if (now - entry.cachedAt > maxAgeMs) return undefined;
    // A copy: @fastify/session mutates the object it is given, and two
    // requests must never share one.
    return structuredClone(entry.data);
  }

  /** Session data cached within `ttlMs`, or undefined. */
  fresh(sid) {
    return this.#lookup(sid, this.ttlMs);
  }

  /** Session data cached within `staleMs` -- only for when the database times out. */
  stale(sid) {
    return this.#lookup(sid, this.staleMs);
  }

  /**
   * Remember a session.
   * @param {string} sid
   * @param {object} data
   * @param {Date|number|string|null} sessionExpiresAt  when the session itself expires
   */
  set(sid, data, sessionExpiresAt = null) {
    if (!sid || data == null) return;
    const expiresAt = sessionExpiresAt ? new Date(sessionExpiresAt).getTime() : null;
    this.entries.delete(sid); // re-insert so Map order tracks recency
    this.entries.set(sid, {
      data: structuredClone(data),
      cachedAt: this.now(),
      sessionExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  /** Move a cached session's expiry (store.touch). */
  extend(sid, sessionExpiresAt) {
    const entry = this.entries.get(sid);
    if (!entry) return;
    const expiresAt = new Date(sessionExpiresAt).getTime();
    if (Number.isFinite(expiresAt)) entry.sessionExpiresAt = expiresAt;
  }

  delete(sid) {
    this.entries.delete(sid);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
