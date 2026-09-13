/**
 * lib/apiKeys.js
 *
 * Pure key-format, scope and path-resolution logic for the per-client API
 * credential scheme.  Deliberately free of any database import so the auth
 * rules are testable on their own and so importing them never opens a
 * connection pool.
 *
 * Database access lives in controllers/apiClientController.js, which
 * re-exports the pieces callers are expected to use.
 */

import crypto from "crypto";

/**
 * Canonical scope list — one per API surface, mirroring api/routes/*.
 *
 * Deliberately coarse and deliberately without wildcards: granting a key broad
 * access must be an explicit act of selecting every scope, never a single "*".
 */
export const API_SCOPES = [
  "announcement",
  "application",
  "badges",
  "bridge",
  "config",
  "discord",
  "events",
  "filter",
  "finance",
  "punishments",
  "ranks",
  "report",
  "scheduler",
  "server",
  "session",
  "shopdirectory",
  "user",
  "vault",
  "web",
  "adminUsers",
  "internal",
];

/**
 * Path prefix → required scope, covering every route registered inside the
 * verifyToken plugin scope.  Not every one lives under /api: adminUsers mounts
 * at /admin/users, badges also at /admin/badges, and config at /policy and
 * /social.
 *
 * Matching is longest-prefix-first, so /api/discord-punishments resolves to
 * `punishments` rather than being swallowed by the /api/discord entry.
 */
const SCOPE_ROUTES = [
  ["/api/announcement", "announcement"],
  ["/api/application", "application"],
  ["/api/badges", "badges"],
  ["/admin/badges", "badges"],
  ["/api/bridge", "bridge"],
  // zander-addon's StoreCommandService posts to /api/command-bridge/{claim,
  // complete,fail}. Those handlers are not in this repo, but the mapping is
  // here so that if they are served the plugin is scoped rather than 403'd.
  ["/api/command-bridge", "bridge"],
  ["/policy", "config"],
  ["/social", "config"],
  // zander-addon requests /api/config/{policy,social} while api/routes/config.js
  // serves them at /policy and /social — a pre-existing mismatch. Mapped so the
  // plugin path is correctly scoped if the routes are ever aliased.
  ["/api/config", "config"],
  ["/api/discord-punishments", "punishments"],
  ["/api/discord", "discord"],
  ["/api/events", "events"],
  ["/api/filter", "filter"],
  ["/api/finance", "finance"],
  ["/api/punishments", "punishments"],
  ["/api/rank", "ranks"],
  ["/api/report", "report"],
  ["/api/scheduler", "scheduler"],
  ["/api/server", "server"],
  ["/api/session", "session"],
  ["/api/shop", "shopdirectory"],
  ["/api/user", "user"],
  ["/api/vault", "vault"],
  ["/api/web", "web"],
  ["/admin/users", "adminUsers"],
].sort((a, b) => b[0].length - a[0].length);

const KEY_NAMESPACE = "zdr";
const PREFIX_LENGTH = 8;
const SECRET_LENGTH = 40;
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Draw `length` characters from `alphabet` using rejection sampling so every
 * character is uniformly distributed.  A plain `byte % alphabet.length` biases
 * towards the earlier characters whenever 256 is not a multiple of the
 * alphabet size.
 */
function randomString(length, alphabet) {
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";

  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= max) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }

  return out;
}

/** SHA-256 hex of the full key. Only this is ever persisted. */
export function hashKey(fullKey) {
  return crypto.createHash("sha256").update(String(fullKey), "utf8").digest("hex");
}

/**
 * Generate a credential of the form `zdr_<8 char prefix>_<40 char secret>`.
 *
 * The prefix is stored in the clear and is what the auth path looks the client
 * up by, so verification is one indexed read rather than a scan over every row.
 *
 * @returns {{fullKey: string, keyPrefix: string, keyHash: string}}
 */
export function generateKey() {
  const keyPrefix = randomString(PREFIX_LENGTH, PREFIX_ALPHABET);
  const secret = randomString(SECRET_LENGTH, SECRET_ALPHABET);
  const fullKey = `${KEY_NAMESPACE}_${keyPrefix}_${secret}`;

  return { fullKey, keyPrefix, keyHash: hashKey(fullKey) };
}

/**
 * Split a presented token and validate its shape, so a malformed value never
 * reaches the database.
 *
 * @returns {{keyPrefix: string}|null}
 */
export function parseKey(token) {
  if (typeof token !== "string") return null;

  const parts = token.split("_");
  if (parts.length !== 3) return null;

  const [namespace, keyPrefix, secret] = parts;
  if (namespace !== KEY_NAMESPACE) return null;
  if (keyPrefix.length !== PREFIX_LENGTH || secret.length !== SECRET_LENGTH) return null;
  if (!/^[a-z0-9]+$/.test(keyPrefix)) return null;

  return { keyPrefix };
}

/**
 * Constant-time comparison of a presented key against a stored hash.
 * Both sides are fixed-width hex digests, so timingSafeEqual is safe to use
 * directly without leaking length.
 */
export function verifyKeyHash(fullKey, storedHash) {
  if (typeof storedHash !== "string" || storedHash.length !== 64) return false;

  const presented = Buffer.from(hashKey(fullKey), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (presented.length !== stored.length) return false;

  return crypto.timingSafeEqual(presented, stored);
}

/**
 * Required scope for a request path, or null when the path is not a
 * token-protected API surface.
 *
 * A null result is treated as deny by the auth hook: an unmapped route must
 * fail closed rather than become reachable by any key.
 */
export function resolveScope(urlPath) {
  if (typeof urlPath !== "string") return null;

  const path = urlPath.split("?")[0];

  for (const [prefix, scope] of SCOPE_ROUTES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return scope;
  }

  return null;
}

/** Every prefix→scope pair, for tests and documentation. */
export function scopeRoutes() {
  return SCOPE_ROUTES.map(([prefix, scope]) => ({ prefix, scope }));
}
