/**
 * lib/forums/forumBridgeState.mjs
 *
 * Small shared state for the forum bridge:
 *  - a short-lived record of Discord thread changes the bridge made itself, so
 *    the threadUpdate listener does not read them back as user actions;
 *  - a cache of bridged categories/channels (invalidated when the dashboard
 *    changes a bridge);
 *  - per-thread serialisation, so a reply is never processed before the
 *    Discord post it belongs to.
 *
 * Imports nothing app-specific, so it is unit-testable.
 */

const SELF_CHANGE_TTL_MS = 30_000;
const selfChanges = new Map(); // threadId -> { expiry, fields: { name?, locked? } }

/**
 * Note that the bridge is about to set these thread fields itself (e.g.
 * { locked: true } or { name: "New title" }). Only a threadUpdate that lands
 * on exactly this value is treated as the bridge's own; a Discord moderator's
 * different change in the same window is still mirrored.
 */
export function markSelfChange(threadId, expected = {}, now = Date.now()) {
  if (!threadId) return;
  const key = String(threadId);
  const entry = selfChanges.get(key);
  const fields = entry && entry.expiry >= now ? entry.fields : {};
  selfChanges.set(key, { expiry: now + SELF_CHANGE_TTL_MS, fields: { ...fields, ...expected } });
}

/**
 * Is this thread field change one the bridge made itself? A match is consumed,
 * so a later identical change by a moderator is not swallowed too.
 */
export function isSelfChange(threadId, field, value, now = Date.now()) {
  const key = String(threadId);
  const entry = selfChanges.get(key);
  if (!entry) return false;
  if (entry.expiry < now) {
    selfChanges.delete(key);
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(entry.fields, field) || entry.fields[field] !== value) return false;
  delete entry.fields[field];
  if (!Object.keys(entry.fields).length) selfChanges.delete(key);
  return true;
}

// --------------------------------------------------------------------------
// Bridge cache
// --------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
let cache = { at: null, byCategory: new Map(), byChannel: new Map() };

/** Replace the cache with a fresh list of enabled bridges. */
export function setBridgeCache(bridges, now = Date.now()) {
  cache = {
    at: now,
    byCategory: new Map(bridges.map((b) => [Number(b.categoryId), b])),
    byChannel: new Map(bridges.map((b) => [String(b.channelId), b])),
  };
}

export function isBridgeCacheFresh(now = Date.now()) {
  return cache.at !== null && now - cache.at < CACHE_TTL_MS;
}

export function invalidateBridgeCache() {
  cache = { at: null, byCategory: new Map(), byChannel: new Map() };
}

/** How many bridges are cached (0 means nothing to sync). */
export function cachedBridgeCount() {
  return cache.byCategory.size;
}

export function cachedBridgeForCategory(categoryId) {
  return cache.byCategory.get(Number(categoryId)) || null;
}

export function cachedBridgeForChannel(channelId) {
  return cache.byChannel.get(String(channelId)) || null;
}

// --------------------------------------------------------------------------
// Per-thread serialisation
// --------------------------------------------------------------------------

const chains = new Map(); // key -> Promise

/** Run `task` after every earlier task queued under the same key. */
export function runSerial(key, task) {
  const k = String(key);
  const previous = chains.get(k) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  chains.set(k, next);
  next.finally(() => {
    if (chains.get(k) === next) chains.delete(k);
  }).catch(() => {});
  return next;
}
