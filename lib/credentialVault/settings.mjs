/**
 * lib/credentialVault/settings.mjs
 *
 * Vault security settings: defaults, bounds and parsing. Values are stored in
 * credentialVaultSettings and edited by vault administrators; every value is
 * clamped here so a bad row can never, for example, stretch a challenge past
 * 30 seconds or switch reauthentication off (there is no such setting).
 */

import { MAX_CHALLENGE_TTL_SECONDS } from "./constants.mjs";

export const NOTIFY_EVENTS = Object.freeze({
  notifyAccessRequested: "Access requested",
  notifyAccessDecided: "Access request approved or rejected",
  notifyCredentialUpdated: "Credential updated",
  notifySecretRevealed: "Secret revealed or copied",
  notifyRotationDue: "Credential requires rotation",
  notifyPermissionChanged: "Permissions changed",
  notifySuspicious: "Suspicious access attempts",
});

export const SETTING_DEFINITIONS = Object.freeze({
  revealSeconds: { type: "int", min: 5, max: 60, default: 15, label: "Seconds a revealed secret stays visible" },
  clipboardClearSeconds: {
    type: "int",
    min: 0,
    max: 120,
    default: 30,
    label: "Try to clear the clipboard after copying (seconds, 0 = off; best effort)",
  },
  challengeTtlSeconds: {
    type: "int",
    min: 10,
    max: MAX_CHALLENGE_TTL_SECONDS,
    default: MAX_CHALLENGE_TTL_SECONDS,
    label: "Seconds a verification challenge stays valid",
  },
  maxFailedAttempts: { type: "int", min: 3, max: 10, default: 5, label: "Failed verifications before lockout" },
  lockoutMinutes: { type: "int", min: 5, max: 1440, default: 15, label: "Lockout length (minutes)" },
  requireDedicatedVaultPassword: {
    type: "bool",
    default: false,
    label: "Require a dedicated vault password for everyone (instead of the Zander account password)",
  },
  rotationReminderDays: { type: "int", min: 1, max: 90, default: 14, label: "Warn this many days before expiry or rotation" },
  reviewIntervalDays: { type: "int", min: 30, max: 730, default: 180, label: "Flag credentials not reviewed for this many days" },
  broadAccessThreshold: { type: "int", min: 2, max: 500, default: 15, label: "Flag credentials reachable by more than this many people" },
  auditRetentionDays: { type: "int", min: 90, max: 3650, default: 730, label: "Keep audit events for (days)" },
  requestExpiryDays: { type: "int", min: 1, max: 90, default: 14, label: "Close unanswered access requests after (days)" },
  ...Object.fromEntries(
    // Reveal/copy alerts are off by default: on a busy vault they drown out the rest.
    Object.entries(NOTIFY_EVENTS).map(([key, label]) => [key, { type: "bool", default: key !== "notifySecretRevealed", label: `Notify: ${label}` }])
  ),
});

function parseOne(def, raw) {
  if (raw === undefined || raw === null || raw === "") return def.default;
  if (def.type === "bool") {
    if (raw === true || raw === "1" || raw === "true" || raw === "on" || raw === 1) return true;
    if (raw === false || raw === "0" || raw === "false" || raw === "off" || raw === 0) return false;
    return def.default;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def.default;
  return Math.min(def.max, Math.max(def.min, n));
}

/** Merge stored rows ({key: string}) over defaults, clamping everything. */
export function resolveSettings(stored = {}) {
  const out = {};
  for (const [key, def] of Object.entries(SETTING_DEFINITIONS)) {
    out[key] = parseOne(def, stored[key]);
  }
  return out;
}

/** Normalise a submitted settings form into { key: stringValue } rows to save. */
export function normaliseSettingsForm(body = {}) {
  const rows = {};
  for (const [key, def] of Object.entries(SETTING_DEFINITIONS)) {
    if (def.type === "bool") rows[key] = body[key] ? "1" : "0";
    else rows[key] = String(parseOne(def, body[key]));
  }
  return rows;
}
