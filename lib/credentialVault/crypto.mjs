/**
 * lib/credentialVault/crypto.mjs
 *
 * Envelope encryption for the Credential Vault.
 *
 *   secret payload --AES-256-GCM(DEK)--> ciphertext        (credentialSecretVersions)
 *   DEK            --AES-256-GCM(KEK)--> wrappedKey        (credentialKeys)
 *   KEK            lives outside the database (CREDENTIAL_VAULT_KEKS)
 *
 * Node's built-in crypto only — no custom primitives. Every ciphertext carries
 * associated data that binds it to the credential (and version), so a row
 * copied onto another credential fails authentication instead of decrypting.
 *
 * No database import: unit-testable on its own.
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Format byte at the front of every blob so the layout can change later. */
const FORMAT_V1 = 0x01;

export class VaultConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultConfigurationError";
  }
}

export class VaultDecryptionError extends Error {
  constructor(message = "Decryption failed") {
    super(message);
    this.name = "VaultDecryptionError";
  }
}

// ---------------------------------------------------------------------------
// Low-level AEAD
// ---------------------------------------------------------------------------

/** Encrypt `plaintext` (Buffer) under `key` with `aad`. Returns one Buffer: format|nonce|tag|ciphertext. */
export function seal(key, plaintext, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new VaultConfigurationError("Encryption key must be 32 bytes");
  }
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_V1]), nonce, tag, body]);
}

/** Inverse of seal(). Throws VaultDecryptionError on any tampering or wrong key/aad. */
export function open(key, blob, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new VaultConfigurationError("Encryption key must be 32 bytes");
  }
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES || buf[0] !== FORMAT_V1) {
    throw new VaultDecryptionError("Unrecognised ciphertext format");
  }
  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const tag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const body = buf.subarray(1 + NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(String(aad), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Never echo the underlying error: it can include buffer contents.
    throw new VaultDecryptionError();
  }
}

// ---------------------------------------------------------------------------
// Associated data
// ---------------------------------------------------------------------------

export function secretAad({ vaultId, credentialId, version }) {
  return `zander-cv/secret/v1|vault:${Number(vaultId)}|cred:${Number(credentialId)}|ver:${Number(version)}`;
}

export function dekAad({ credentialId, kekId }) {
  return `zander-cv/dek/v1|cred:${Number(credentialId)}|kek:${String(kekId)}`;
}

export function fingerprintKeyAad({ vaultId, kekId }) {
  return `zander-cv/fpk/v1|vault:${Number(vaultId)}|kek:${String(kekId)}`;
}

// ---------------------------------------------------------------------------
// Key provider (KEK). Swap EnvKeyProvider for a KMS-backed provider by
// implementing the same three members.
// ---------------------------------------------------------------------------

const KEK_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Parse CREDENTIAL_VAULT_KEKS: "v1:<base64 32 bytes>,v2:<base64 32 bytes>".
 * Throws VaultConfigurationError with a message that never includes key material.
 */
export function parseKekList(raw) {
  const keys = new Map();
  const text = String(raw ?? "").trim();
  if (!text) return keys;
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep <= 0) throw new VaultConfigurationError("CREDENTIAL_VAULT_KEKS entries must look like id:base64key");
    const id = entry.slice(0, sep).trim();
    const material = entry.slice(sep + 1).trim();
    if (!KEK_ID_PATTERN.test(id)) throw new VaultConfigurationError("CREDENTIAL_VAULT_KEKS has an invalid key id");
    if (keys.has(id)) throw new VaultConfigurationError(`CREDENTIAL_VAULT_KEKS lists key id ${id} twice`);
    const key = Buffer.from(material, "base64");
    if (key.length !== KEY_BYTES || key.toString("base64").replace(/=+$/, "") !== material.replace(/=+$/, "")) {
      throw new VaultConfigurationError(`CREDENTIAL_VAULT_KEKS key ${id} must be exactly 32 bytes of base64`);
    }
    if (key.every((b) => b === 0)) throw new VaultConfigurationError(`CREDENTIAL_VAULT_KEKS key ${id} is all zeros`);
    keys.set(id, key);
  }
  return keys;
}

export class EnvKeyProvider {
  #keys;
  #activeId;

  constructor({ keks, activeKekId }) {
    this.#keys = parseKekList(keks);
    if (this.#keys.size === 0) throw new VaultConfigurationError("CREDENTIAL_VAULT_KEKS is not set");
    const active = String(activeKekId ?? "").trim();
    if (!active) throw new VaultConfigurationError("CREDENTIAL_VAULT_ACTIVE_KEK is not set");
    if (!this.#keys.has(active)) {
      throw new VaultConfigurationError("CREDENTIAL_VAULT_ACTIVE_KEK does not name a key in CREDENTIAL_VAULT_KEKS");
    }
    this.#activeId = active;
  }

  get activeKekId() {
    return this.#activeId;
  }

  hasKek(kekId) {
    return this.#keys.has(kekId);
  }

  /** Wrap a 32-byte data key under the active KEK. */
  async wrap(dataKey, aadFor) {
    const kekId = this.#activeId;
    const wrapped = seal(this.#keys.get(kekId), dataKey, aadFor(kekId));
    return { kekId, wrapped };
  }

  async unwrap(kekId, wrapped, aadFor) {
    const kek = this.#keys.get(kekId);
    if (!kek) throw new VaultConfigurationError(`Key-encryption key ${kekId} is not loaded`);
    const key = open(kek, wrapped, aadFor(kekId));
    if (key.length !== KEY_BYTES) throw new VaultDecryptionError("Unwrapped key has the wrong length");
    return key;
  }

  /** For tests and diagnostics: never exposes key material. */
  describe() {
    return { provider: "env", activeKekId: this.#activeId, loadedKekIds: [...this.#keys.keys()] };
  }
}

/** Build the provider from process.env, or return null with a reason when unconfigured. */
export function keyProviderFromEnv(env = process.env) {
  try {
    return {
      provider: new EnvKeyProvider({
        keks: env.CREDENTIAL_VAULT_KEKS,
        activeKekId: env.CREDENTIAL_VAULT_ACTIVE_KEK,
      }),
      error: null,
    };
  } catch (error) {
    if (error instanceof VaultConfigurationError) return { provider: null, error: error.message };
    throw error;
  }
}

export function generateKek() {
  return crypto.randomBytes(KEY_BYTES).toString("base64");
}

export function generateDataKey() {
  return crypto.randomBytes(KEY_BYTES);
}

// ---------------------------------------------------------------------------
// Secret payloads
// ---------------------------------------------------------------------------

/** Encrypt a { field: value } object for one credential version. */
export function encryptSecretPayload(dataKey, fields, aadParts) {
  const clean = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (typeof v === "string" && v.length > 0) clean[k] = v;
  }
  const plaintext = Buffer.from(JSON.stringify(clean), "utf8");
  try {
    return seal(dataKey, plaintext, secretAad(aadParts));
  } finally {
    plaintext.fill(0);
  }
}

/** Decrypt a version payload back to { field: value }. */
export function decryptSecretPayload(dataKey, ciphertext, aadParts) {
  const plaintext = open(dataKey, ciphertext, secretAad(aadParts));
  try {
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new VaultDecryptionError("Malformed payload");
    return parsed;
  } finally {
    plaintext.fill(0);
  }
}

/** Keyed fingerprint used only to detect the same password on two credentials. */
export function passwordFingerprint(fingerprintKey, password) {
  if (!fingerprintKey || typeof password !== "string" || !password) return null;
  return crypto.createHmac("sha256", fingerprintKey).update(`zander-cv/pw-fp/v1|${password}`, "utf8").digest("hex");
}

/**
 * Rough 0-4 strength estimate for the health page, computed at save time on
 * the server (the value is never sent anywhere). Deliberately conservative.
 */
export function estimatePasswordStrength(password) {
  if (typeof password !== "string" || !password) return null;
  const chars = [...password];
  // Repetition adds little: count at most two characters per distinct one.
  const length = Math.min(chars.length, new Set(chars).size * 2);
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;
  let bits = length * Math.log2(Math.max(pool, 1));
  // Penalise obvious structure: repeats, sequences, a single class.
  if (/(.)\1{2,}/.test(password)) bits -= 10;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|password|letmein|admin)/i.test(password)) bits -= 20;
  if (bits < 28) return 0;
  if (bits < 40) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Misc hashing helpers
// ---------------------------------------------------------------------------

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function constantTimeEqualHex(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
