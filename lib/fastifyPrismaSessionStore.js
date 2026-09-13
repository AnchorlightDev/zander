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
 *   get()   – 3 s timeout, resolves as a cache-miss so the user just needs
 *             to log in again rather than seeing a white page.
 *   set()   – 3 s timeout, resolves as success; session data will be written
 *             on the next request.
 *   touch() – 2 s timeout, resolves as success; the TTL update is not
 *             critical and must never block a response.
 */

import { prisma } from "../controllers/databaseController.js";

const DEFAULT_TTL_MS = 86400 * 7 * 1000; // 7 days — matches app.js cookie.maxAge
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // prune expired sessions every 2 min

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

  constructor() {
    // Background cleanup of expired rows.
    this.#cleanupTimer = setInterval(() => {
      prisma.session
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch((err) =>
          console.error("[SessionStore] Expired session cleanup error:", err.message)
        );
    }, CLEANUP_INTERVAL_MS);

    // Don't block process exit.
    if (this.#cleanupTimer.unref) this.#cleanupTimer.unref();
  }

  /** Retrieve a session by its session ID (sid). */
  get(sid, callback) {
    const work = prisma.session
      .findUnique({ where: { sid } })
      .then((row) => {
        if (!row) return null;
        if (new Date(row.expiresAt) < new Date()) {
          prisma.session.deleteMany({ where: { sid } }).catch(() => {});
          return null;
        }
        try {
          return JSON.parse(row.data);
        } catch {
          return null;
        }
      });

    // Two-arg .then(onFulfilled, onRejected) — NOT .then().catch() — so that if
    // invoking `callback` itself throws (e.g. the caller tries to write reply
    // headers on an already-finished response), that throw doesn't fall into
    // onRejected and cause a second, unhandled callback invocation.
    withTimeout(work, GET_TIMEOUT_MS, `get(${sid})`, null).then(
      (data) => invokeCallbackSafely(callback, null, data),
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

    // Atomic upsert — safe under concurrent requests.
    const work = prisma.$executeRaw`
      INSERT INTO sessions (id, sid, \`data\`, expiresAt)
      VALUES (${sid}, ${sid}, ${data}, ${expiresAt})
      ON DUPLICATE KEY UPDATE
        \`data\`    = VALUES(\`data\`),
        expiresAt = VALUES(expiresAt)
    `;

    // See get() above for why this must be two-arg .then(), not .then().catch().
    withTimeout(work, SET_TIMEOUT_MS, `set(${sid})`, undefined).then(
      () => invokeCallbackSafely(callback, null),
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

    // Call back immediately so the HTTP response is never blocked by this
    // housekeeping write.  The Prisma query continues in the background.
    invokeCallbackSafely(callback, null);

    prisma.session
      .updateMany({ where: { sid }, data: { expiresAt } })
      .catch((err) =>
        console.error(`[SessionStore] touch(${sid}) failed in background:`, err.message)
      );
  }

  /** Delete a session. */
  destroy(sid, callback) {
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
  }
}
