/**
 * lib/credentialVault/vaultPassword.mjs
 *
 * Dedicated vault-access passwords: Argon2id verifiers only, never the
 * password. Parameters follow the OWASP Password Storage Cheat Sheet's first
 * Argon2id option (m = 19 MiB, t = 2, p = 1), which keeps a verification well
 * under 100 ms and the memory cost small enough for a 512 MB instance.
 */

import argon2 from "argon2";
import { estimatePasswordStrength } from "./crypto.mjs";

export const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

export const MIN_VAULT_PASSWORD_LENGTH = 12;
export const MAX_VAULT_PASSWORD_LENGTH = 256;

/** Returns null when acceptable, otherwise a message for the user. */
export function vaultPasswordProblem(password, { username = "", accountPasswordSame = false } = {}) {
  if (typeof password !== "string" || password.length < MIN_VAULT_PASSWORD_LENGTH) {
    return `Use at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_VAULT_PASSWORD_LENGTH) return "That password is too long.";
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) {
    return "Do not include your username.";
  }
  if ((estimatePasswordStrength(password) ?? 0) < 2) {
    return "That password is too easy to guess. Use a longer passphrase.";
  }
  if (accountPasswordSame) return "Use a different password from your Zander account password.";
  return null;
}

export async function hashVaultPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** Constant-time verify (argon2.verify compares in constant time). Never throws. */
export async function verifyVaultPassword(verifier, password) {
  if (typeof verifier !== "string" || !verifier.startsWith("$argon2id$")) return false;
  if (typeof password !== "string" || !password || password.length > MAX_VAULT_PASSWORD_LENGTH) return false;
  try {
    return await argon2.verify(verifier, password);
  } catch {
    return false;
  }
}

/** A real verifier to burn time against when the user has none, so timing does not reveal enrolment. */
let dummyVerifierPromise = null;
export function dummyVerifier() {
  if (!dummyVerifierPromise) dummyVerifierPromise = argon2.hash("zander-cv-dummy-password", ARGON2_OPTIONS);
  return dummyVerifierPromise;
}
