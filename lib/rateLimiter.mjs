/**
 * Simple in-memory rate limiter for Fastify route handlers.
 * Tracks request counts per IP + route key within a sliding window.
 */

const store = new Map();

// Hard cap so a client rotating identities cannot grow the map without bound
// inside one window. Oldest buckets go first; they are the most likely to be
// stale anyway.
const MAX_BUCKETS = 50_000;

// Periodically clear expired buckets to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) {
      store.delete(key);
    }
  }
}, 60_000);

/**
 * Check whether the incoming request should be rate-limited.
 *
 * @param {object} req - Fastify request object
 * @param {object} res - Fastify reply object
 * @param {object} options
 * @param {number} options.windowMs - Time window in milliseconds (default 15 min)
 * @param {number} options.max      - Maximum requests per window per IP (default 10)
 * @returns {boolean} true if the request is allowed; false if it was rate-limited
 *                    (a 429 response is sent automatically when false is returned)
 */
export function checkRateLimit(req, res, { windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  // req.ip is already the client address as seen by the trusted proxy (see
  // trustProxy in app.js). Reading X-Forwarded-For here would take whatever
  // the client wrote into that header and hand out a fresh bucket per
  // request.
  const ip = req.ip || "unknown";

  // req.routerPath was removed in Fastify 5; routeOptions.url is the
  // replacement.  Falling back to req.url keeps per-path bucketing if
  // neither is populated (e.g. 404s handled outside the router).
  const routeKey = `${req.method}:${req.routeOptions?.url || req.url}`;
  const key = `${routeKey}:${ip}`;
  const now = Date.now();

  let bucket = store.get(key);
  if (!bucket || now > bucket.resetAt) {
    if (!bucket && store.size >= MAX_BUCKETS) {
      store.delete(store.keys().next().value);
    }
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }

  bucket.count++;

  if (bucket.count > max) {
    res.status(429).send({
      success: false,
      message: "Too many requests. Please try again later.",
    });
    return false;
  }

  return true;
}
