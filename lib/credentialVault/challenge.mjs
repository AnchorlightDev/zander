/**
 * lib/credentialVault/challenge.mjs
 *
 * Token handling for one-time reauthentication challenges. The token is a
 * 256-bit random value handed to the browser once; the database stores only
 * its SHA-256, so a database reader cannot replay a challenge.
 *
 * No database import: unit-testable.
 */

import crypto from "node:crypto";
import { CHALLENGE_ACTIONS, MAX_CHALLENGE_TTL_SECONDS } from "./constants.mjs";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateChallengeToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function isWellFormedToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function hashChallengeToken(token) {
  return crypto.createHash("sha256").update(`zander-cv/challenge/v1|${token}`, "utf8").digest("hex");
}

/**
 * Bind challenges to the session without storing the session id itself.
 * Returns null when there is no session id — callers must refuse in that case.
 */
export function hashSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length < 8) return null;
  return crypto.createHash("sha256").update(`zander-cv/session/v1|${sessionId}`, "utf8").digest("hex");
}

/** Short, non-reversible session label for audit rows. */
export function auditSessionLabel(sessionId) {
  const h = hashSessionId(sessionId);
  return h ? h.slice(0, 16) : null;
}

export function clampChallengeTtl(seconds) {
  const n = Number.parseInt(seconds, 10);
  if (!Number.isFinite(n)) return MAX_CHALLENGE_TTL_SECONDS;
  return Math.min(MAX_CHALLENGE_TTL_SECONDS, Math.max(10, n));
}

export function requiredCapabilitiesFor(action) {
  return CHALLENGE_ACTIONS[action] ? [...CHALLENGE_ACTIONS[action]] : null;
}

export function isVersionAction(action) {
  return action === "reveal_version" || action === "restore_version";
}
