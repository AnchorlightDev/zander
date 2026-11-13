/**
 * lib/fastifyPrismaSessionStore.js
 *
 * A minimal Fastify-compatible session store backed by Prisma + MySQL.
 *
 * Why not @quixo3/prisma-session-store?
 * That library wraps every store callback in `setImmediate` (via defer.js).
 * setImmediate fires in Node's "check" phase — after the current I/O cycle.
 * In Fastify's onSend hook pipeline, by the time setImmediate fires, the
 * HTTP response can already be committed via a parallel code path, causing
 * ERR_HTTP_HEADERS_SENT.  This store calls callbacks from Promise microtasks
 * instead, which fire before the next event-loop iteration and don't have
 * that race.
 *
 * set() uses a single atomic `INSERT … ON DUPLICATE KEY UPDATE` so concurrent
 * requests sharing a new session ID can never race into a duplicate-key error.
 *
 * Timeout protection
 * ------------------
 * Every Prisma call is wrapped with a hard deadline.  If the DB doesn't
 * respond in time the callback is called immediately so the HTTP response is
 * never held hostage by a slow/stalled database connection (the classic
 * blank-page symptom).
 *
 *   get()   – 3 s timeout. Falls back to the in-memory copy (lib/sessionCache.mjs)
 *             when there is one, otherwise resolves as a cache-miss so the
 *             user just needs to log in again rather than seeing a white page.
 *   set()   – 3 s timeout, resolves as success; session data will be written
 *             on the next request.
 *   touch() – 2 s timeout, resolves as success; the TTL update is not
 *             critical and must never block a response.
 *
 * In-memory session cache
 * -----------------------
 * Reads within 60 s of the last read or write on this instance come from
 * memory, and a timed-out read falls back to the last known copy (up to 15
 * min, never past the session's expiry) instead of logging the person out.
 * Writes and destroys update the cache immediately. A logout on another
 * instance can take up to 60 s to be seen here. See lib/sessionCache.mjs.
 */

import { prisma } from "../controllers/databaseController.js";
import { SessionCache } from "./sessionCache.mjs";

/** Marks a get() that ran out of time, so it can fall back to the cache. */
const GET_TIMED_OUT = Symbol("get timed out");

const DEFAULT_TTL_MS = 86400 * 7 * 1000; // 7 days — matches app.js cookie.maxAge
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // prune expired sessions every 2 min
// Expired rows (including revoked ones) are kept this long before cleanup, so
// set() cannot re-create a revoked session from a copy another instance still
// holds in memory. Longer than SessionCache's staleMs (15 min).
const EXPIRED_ROW_RETENTION_MS = 20 * 60 * 1000;

/** Every live store's cache, so destroySessionsForUser can evict from them. */
const liveCaches = new Set();

/** sid -> revokedAt (ms), for sids revoked on this instance. */
const revokedSids = new Map();

function isRecentlyRevoked(sid) {
  const at = revokedSids.get(sid);
  if (at === undefined) return false;
  if (Date.now() - at > EXPIRED_ROW_RETENTION_MS) {
    revokedSids.delete(sid);
    return false;
  }
  return true;
}

const GET_TIMEOUT_MS   = 3000;
const SET_TIMEOUT_MS   = 3000;
const TOUCH_TIMEOUT_MS = 2000;

/**
 * Race a promise against a wall-clock deadline.
 *
 * @param {Promise}  promise   The async work to race.
 * @param {number}   ms        Deadline in milliseconds.
 * @param {string}   label     Label used in the warning log.
 * @param {*}        fallback  Value to resolve with on timeout (use a
 *                             sentinel Error to reject instead).
 */
function withTimeout(promise, ms, label, fallback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(`[SessionStore] ${label} timed out after ${ms}ms — proceeding without blocking response`);
      if (fallback instanceof Error) reject(fallback);
      else resolve(fallback);
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err);  }
    );
  });
}

/** Session IDs are bearer credentials -- never log them in full. */
function redactSid(sid) {
  return typeof sid === "string" ? `${sid.slice(0, 6)}…` : "?";
}

function isHeadersAlreadySentError(error) {
  return (
    error?.code === "ERR_HTTP_HEADERS_SENT" ||
    /headers after they are sent to the client/i.test(String(error?.message || ""))
  );
}

function invokeCallbackSafely(callback, ...args) {
  try {
    callback(...args);
  } catch (error) {
    if (isHeadersAlreadySentError(error)) {
      return;
    }

    throw error;
  }
}

export class FastifyPrismaSessionStore {
  #cleanupTimer = null;
  #cache;

  /** @param {{ cache?: SessionCache }} [opts] */
  constructor({ cache = new SessionCache() } = {}) {
    this.#cache = cache;
    liveCaches.add(cache);

    // Background cleanup of expired rows.
    this.#cleanupTimer = setInterval(() => {
      prisma.session
        .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - EXPIRED_ROW_RETENTION_MS) } } })
        .catch((err) =>
          console.error("[SessionStore] Expired session cleanup error:", err.message)
        );
    }, CLEANUP_INTERVAL_MS);

    // Don't block process exit.
    if (this.#cleanupTimer.unref) this.#cleanupTimer.unref();
  }

  /** Retrieve a session by its session ID (sid). */
  get(sid, callback) {
    // Recently seen on this instance: answer from memory. Still delivered from
    // a microtask, like every other store callback (see the header).
    const cached = this.#cache.fresh(sid);
    if (cached !== undefined) {
      Promise.resolve().then(() => invokeCallbackSafely(callback, null, cached));
      return;
    }

    const work = prisma.session
      .findUnique({ where: { sid } })
      .then((row) => {
        if (!row) {
          this.#cache.delete(sid);
          return null;
        }
        if (new Date(row.expiresAt) < new Date()) {
          // Left in place for the cleanup timer: the expired row is what stops
          // set() from bringing a revoked session back.
          this.#cache.delete(sid);
          return null;
        }
        try {
          const data = JSON.parse(row.data);
          this.#cache.set(sid, data, row.expiresAt);
          return data;
        } catch {
          return null;
        }
      });

    // Two-arg .then(onFulfilled, onRejected) — NOT .then().catch() — so that if
    // invoking `callback` itself throws (e.g. the caller tries to write reply
    // headers on an already-finished response), that throw doesn't fall into
    // onRejected and cause a second, unhandled callback invocation.
    withTimeout(work, GET_TIMEOUT_MS, `get(${redactSid(sid)})`, GET_TIMED_OUT).then(
      (data) => {
        if (data === GET_TIMED_OUT) {
          // The database is slow: keep the person signed in on the last known
          // copy rather than treating this request as logged out.
          const stale = this.#cache.stale(sid);
          if (stale !== undefined) {
            console.warn(`[SessionStore] get(${redactSid(sid)}) served from memory while the database is slow`);
          }
          return invokeCallbackSafely(callback, null, stale ?? null);
        }
        invokeCallbackSafely(callback, null, data);
      },
      (err) => invokeCallbackSafely(callback, err)
    );
  }

  /** Persist (create or update) a session. */
  set(sid, session, callback) {
    const ttlMs =
      session?.cookie?.maxAge != null
        ? session.cookie.maxAge
        : DEFAULT_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs);

    let data;
    try {
      data = JSON.stringify(session);
    } catch (err) {
      return invokeCallbackSafely(callback, err);
    }

    // Visible to this instance's next read straight away, even if the database
    // write below is slow.
    this.#cache.set(sid, JSON.parse(data), expiresAt);

    // Compared as a bound Date (not NOW()) so it uses the same time zone
    // Prisma stores expiresAt in.
    const now = new Date();
    // Atomic upsert — safe under concurrent requests. An existing row that
    // has already expired (or was revoked by destroySessionsForUser) is left
    // as it is: a write must never bring a dead session back to life. `data`
    // is assigned first because MySQL applies these left to right.
    const work = prisma.$executeRaw`
      INSERT INTO sessions (id, sid, \`data\`, expiresAt)
      VALUES (${sid}, ${sid}, ${data}, ${expiresAt})
      ON DUPLICATE KEY UPDATE
        \`data\`    = IF(expiresAt <= ${now}, \`data\`, VALUES(\`data\`)),
        expiresAt = IF(expiresAt <= ${now}, expiresAt, VALUES(expiresAt))
    `;

    // See get() above for why this must be two-arg .then(), not .then().catch().
    withTimeout(work, SET_TIMEOUT_MS, `set(${redactSid(sid)})`, undefined).then(
      (affected) => {
        // 0 rows changed: the row is dead (or the write was a no-op). Drop the
        // optimistic copy so the next read asks the database. A dead row can
        // also report 1 when the driver counts matched rows (CLIENT_FOUND_ROWS),
        // so sids revoked on this instance are checked by name as well.
        if (affected === 0 || isRecentlyRevoked(sid)) this.#cache.delete(sid);
        invokeCallbackSafely(callback, null);
      },
      (err) => invokeCallbackSafely(callback, err)
    );
  }

  /** Extend a session's TTL without changing its data. */
  touch(sid, session, callback) {
    const ttlMs =
      session?.cookie?.maxAge != null
        ? session.cookie.maxAge
        : DEFAULT_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs);

    this.#cache.extend(sid, expiresAt);

    // Call back immediately so the HTTP response is never blocked by this
    // housekeeping write.  The Prisma query continues in the background.
    invokeCallbackSafely(callback, null);

    prisma.session
      .updateMany({ where: { sid, expiresAt: { gt: new Date() } }, data: { expiresAt } })
      .catch((err) =>
        console.error(`[SessionStore] touch(${redactSid(sid)}) failed in background:`, err.message)
      );
  }

  /** Delete a session. */
  destroy(sid, callback) {
    // Gone from this instance at once (logout, session regenerate).
    this.#cache.delete(sid);
    // See get() above for why this must be two-arg .then(), not .then().catch().
    prisma.session.deleteMany({ where: { sid } }).then(
      () => invokeCallbackSafely(callback, null),
      (err) => invokeCallbackSafely(callback, err)
    );
  }

  /** Stop the background cleanup timer. */
  close() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    liveCaches.delete(this.#cache);
  }
}

/**
 * Delete every stored session that belongs to a user.
 *
 * Used after a password reset so a hijacker's session dies with the old
 * password instead of surviving until it expires. Session data is the JSON
 * @fastify/session persists, so the user id is read from `$.user.userId`.
 *
 * The rows are expired rather than deleted: set() refuses to revive an
 * expired row, so a request already in flight (or served from another
 * instance's memory) cannot write the session back. This instance's caches
 * are cleared at once; another instance's may serve a copy for up to its
 * fresh window (lib/sessionCache.mjs) but can no longer extend it.
 */
export async function destroySessionsForUser(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id)) return 0;
  for (const cache of liveCaches) cache.deleteForUser(id);
  const revokedAt = new Date(Date.now() - 1000);
  const now = Date.now();
  for (const [sid, at] of revokedSids) {
    if (now - at > EXPIRED_ROW_RETENTION_MS) revokedSids.delete(sid);
  }
  const doomed = await prisma.$queryRaw`
    SELECT sid FROM sessions
     WHERE JSON_EXTRACT(data, '$.user.userId') = ${id}
       AND expiresAt > ${revokedAt}
  `;
  for (const row of doomed ?? []) revokedSids.set(row.sid, now);
  const result = await prisma.$executeRaw`
    UPDATE sessions
       SET expiresAt = ${revokedAt}
     WHERE JSON_EXTRACT(data, '$.user.userId') = ${id}
       AND expiresAt > ${revokedAt}
  `;
  for (const cache of liveCaches) cache.deleteForUser(id);
  return result;
}
