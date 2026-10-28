/**
 * lib/credentialVault/audit.mjs
 *
 * Audit record shaping for the Credential Vault: metadata sanitising and the
 * hash chain. No database import: unit-testable.
 *
 * Chain: hash = SHA-256(prevHash | canonical JSON of the event). Each event
 * commits to everything before it, so editing or deleting a row in the middle
 * breaks verification from that point on.
 */

import crypto from "node:crypto";
import { ALL_SECRET_FIELD_KEYS } from "./constants.mjs";

export const GENESIS_HASH = "0".repeat(64);

/**
 * Keys that must never appear in audit metadata, matched case-insensitively
 * against the key and as a substring (so "newPassword", "apiKeyValue" etc.
 * are caught too). `field` is allowed: it holds a secret field *name*.
 */
const FORBIDDEN_KEY_PATTERN = new RegExp(
  [
    "password",
    "passphrase",
    "secret",
    "token",
    "privatekey",
    "apikey",
    "recoverycode",
    "connectionstring",
    "ciphertext",
    "wrapped",
    "kek",
    "dek",
    "verifier",
    "cookie",
    "session(?!hash|label)",
    "^value$",
    "^values$",
    "^note$",
    ...ALL_SECRET_FIELD_KEYS.map((k) => `^${k.toLowerCase()}$`),
  ].join("|"),
  "i"
);

const MAX_STRING = 300;

/**
 * Keep only scalar, non-sensitive metadata. Anything whose key looks like a
 * secret is dropped, nested objects are flattened to one level, strings are
 * truncated, and the result is JSON-serialisable.
 */
export function sanitiseAuditMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) {
      out[key] = value
        .filter((v) => ["string", "number", "boolean"].includes(typeof v))
        .slice(0, 50)
        .map((v) => (typeof v === "string" ? v.slice(0, 100) : v));
    } else if (value instanceof Date) out[key] = value.toISOString();
  }
  return Object.keys(out).length ? out : null;
}

function canonical(event) {
  // Fixed key order so the same event always hashes the same way.
  return JSON.stringify([
    event.occurredAt instanceof Date ? event.occurredAt.toISOString() : new Date(event.occurredAt).toISOString(),
    event.eventType,
    event.outcome,
    event.actorUserId ?? null,
    event.subjectUserId ?? null,
    event.credentialId ?? null,
    event.collectionId ?? null,
    event.sessionHash ?? null,
    event.ip ?? null,
    event.userAgent ?? null,
    event.metadata ?? null,
  ]);
}

export function chainHash(prevHash, event) {
  return crypto.createHash("sha256").update(`${prevHash}|${canonical(event)}`, "utf8").digest("hex");
}

/**
 * Verify a run of events (ordered by eventId). The first event's prevHash is
 * taken on trust (retention may have trimmed older rows); every link after it
 * must match. Returns { ok, checked, brokenAtEventId }.
 */
export function verifyChain(events) {
  let prev = null;
  let checked = 0;
  for (const event of events) {
    if (prev !== null && event.prevHash !== prev) return { ok: false, checked, brokenAtEventId: event.eventId };
    const expected = chainHash(event.prevHash, event);
    if (expected !== event.hash) return { ok: false, checked, brokenAtEventId: event.eventId };
    prev = event.hash;
    checked += 1;
  }
  return { ok: true, checked, brokenAtEventId: null };
}

export function truncateUserAgent(ua) {
  if (!ua) return null;
  const s = String(ua);
  return s.length > 255 ? s.slice(0, 255) : s;
}
