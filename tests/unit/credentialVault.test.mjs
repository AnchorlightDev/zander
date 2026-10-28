import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  EnvKeyProvider,
  decryptSecretPayload,
  encryptSecretPayload,
  estimatePasswordStrength,
  generateDataKey,
  generateKek,
  keyProviderFromEnv,
  open,
  parseKekList,
  seal,
  dekAad,
  VaultDecryptionError,
} from "../../lib/credentialVault/crypto.mjs";
import {
  checkGrantAuthority,
  effectiveCapabilities,
  holdsAnywhere,
  validateGrantInput,
} from "../../lib/credentialVault/permissions.mjs";
import { chainHash, sanitiseAuditMetadata, verifyChain, GENESIS_HASH } from "../../lib/credentialVault/audit.mjs";
import { resolveSettings, normaliseSettingsForm } from "../../lib/credentialVault/settings.mjs";
import { parseCredentialForm, mergeSecretPayload, normaliseUrl, validateCollectionForm } from "../../lib/credentialVault/input.mjs";
import {
  clampChallengeTtl,
  generateChallengeToken,
  hashChallengeToken,
  hashSessionId,
  isWellFormedToken,
  requiredCapabilitiesFor,
} from "../../lib/credentialVault/challenge.mjs";
import { isSecretFieldName, MAX_CHALLENGE_TTL_SECONDS } from "../../lib/credentialVault/constants.mjs";
import { vaultPasswordProblem, hashVaultPassword, verifyVaultPassword } from "../../lib/credentialVault/vaultPassword.mjs";

describe("credential vault crypto", () => {
  const key = generateDataKey();

  it("round-trips and authenticates associated data", () => {
    const blob = seal(key, Buffer.from("hello"), "aad-1");
    expect(open(key, blob, "aad-1").toString()).toBe("hello");
    expect(() => open(key, blob, "aad-2")).toThrow(VaultDecryptionError);
  });

  it("uses a fresh nonce every time", () => {
    const a = seal(key, Buffer.from("same"), "x");
    const b = seal(key, Buffer.from("same"), "x");
    expect(a.equals(b)).toBe(false);
  });

  it("detects a flipped ciphertext bit", () => {
    const blob = seal(key, Buffer.from("hello world"), "x");
    blob[blob.length - 1] ^= 0x01;
    expect(() => open(key, blob, "x")).toThrow(VaultDecryptionError);
  });

  it("binds secret payloads to credential and version", () => {
    const ct = encryptSecretPayload(key, { password: "p@ss", empty: "" }, { vaultId: 1, credentialId: 5, version: 2 });
    expect(decryptSecretPayload(key, ct, { vaultId: 1, credentialId: 5, version: 2 })).toEqual({ password: "p@ss" });
    expect(() => decryptSecretPayload(key, ct, { vaultId: 1, credentialId: 6, version: 2 })).toThrow();
    expect(() => decryptSecretPayload(key, ct, { vaultId: 1, credentialId: 5, version: 1 })).toThrow();
    expect(ct.toString("latin1")).not.toContain("p@ss");
  });

  it("parses KEK lists strictly and never echoes key material", () => {
    const k = generateKek();
    expect(parseKekList(`v1:${k}`).get("v1").length).toBe(32);
    expect(() => parseKekList(`v1:${Buffer.alloc(16, 1).toString("base64")}`)).toThrow(/32 bytes/);
    expect(() => parseKekList(`v1:${Buffer.alloc(32).toString("base64")}`)).toThrow(/all zeros/);
    expect(() => parseKekList(`v1:${k},v1:${k}`)).toThrow(/twice/);
    try {
      parseKekList(`bad id:${k}`);
    } catch (e) {
      expect(e.message).not.toContain(k);
    }
  });

  it("requires the active KEK to be loaded", () => {
    const k = generateKek();
    expect(() => new EnvKeyProvider({ keks: `v1:${k}`, activeKekId: "v2" })).toThrow();
    expect(keyProviderFromEnv({}).provider).toBeNull();
    expect(keyProviderFromEnv({ CREDENTIAL_VAULT_KEKS: `v1:${k}`, CREDENTIAL_VAULT_ACTIVE_KEK: "v1" }).provider.activeKekId).toBe("v1");
  });

  it("wraps and unwraps data keys, bound to the credential", async () => {
    const p = new EnvKeyProvider({ keks: `v1:${generateKek()}`, activeKekId: "v1" });
    const dek = generateDataKey();
    const { kekId, wrapped } = await p.wrap(dek, (kid) => dekAad({ credentialId: 1, kekId: kid }));
    expect((await p.unwrap(kekId, wrapped, (kid) => dekAad({ credentialId: 1, kekId: kid }))).equals(dek)).toBe(true);
    await expect(p.unwrap(kekId, wrapped, (kid) => dekAad({ credentialId: 2, kekId: kid }))).rejects.toThrow();
    expect(JSON.stringify(p.describe())).not.toMatch(/[A-Za-z0-9+/]{40,}/);
  });

  it("rates passwords roughly", () => {
    expect(estimatePasswordStrength("abc")).toBe(0);
    expect(estimatePasswordStrength("password123")).toBeLessThanOrEqual(1);
    expect(estimatePasswordStrength("vT9#qL2!mZ8@wR4$")).toBe(4);
  });
});

describe("credential vault permissions", () => {
  const cred = { kind: "credential", collectionId: 1, credentialId: 10 };
  const g = (over) => ({ scope: "collection", collectionId: 1, principalType: "user", userId: 1, effect: "allow", capabilities: [], ...over });

  it("denies by default", () => {
    expect(effectiveCapabilities([], cred).size).toBe(0);
  });

  it("reveal implies list and view, but manage_vault implies nothing about secrets", () => {
    expect([...effectiveCapabilities([g({ capabilities: ["reveal"] })], cred)].sort()).toEqual(["list", "reveal", "view"]);
    const admin = [g({ scope: "vault", capabilities: ["manage_vault"] })];
    const caps = effectiveCapabilities(admin, cred);
    expect(caps.has("reveal")).toBe(false);
    expect(caps.has("view")).toBe(false);
  });

  it("deny wins and deny on view removes everything that implies it", () => {
    const grants = [g({ scope: "vault", capabilities: ["reveal", "copy"] }), g({ scope: "credential", credentialId: 10, effect: "deny", capabilities: ["view"] })];
    expect([...effectiveCapabilities(grants, cred)]).toEqual(["list"]);
    const hidden = [g({ capabilities: ["reveal"] }), g({ effect: "deny", capabilities: ["list"] })];
    expect(effectiveCapabilities(hidden, cred).size).toBe(0);
  });

  it("ignores expired and revoked grants", () => {
    const grants = [g({ capabilities: ["reveal"], expiresAt: new Date(Date.now() - 1000) }), g({ capabilities: ["copy"], revokedAt: new Date() })];
    expect(effectiveCapabilities(grants, cred).size).toBe(0);
  });

  it("scopes do not leak across collections or credentials", () => {
    expect(effectiveCapabilities([g({ collectionId: 2, capabilities: ["reveal"] })], cred).size).toBe(0);
    expect(effectiveCapabilities([g({ scope: "credential", credentialId: 11, capabilities: ["reveal"] })], cred).size).toBe(0);
  });

  it("validates grant input against the scope", () => {
    expect(validateGrantInput({ scope: "credential", credentialId: 1, principalType: "user", userId: 2, capabilities: ["manage_vault"] }).ok).toBe(false);
    expect(validateGrantInput({ scope: "vault", principalType: "user", userId: 2, capabilities: ["reveal"], expiresAt: "2000-01-01" }).ok).toBe(false);
    const ok = validateGrantInput({ scope: "collection", collectionId: 3, principalType: "group", groupId: 4, capabilities: "reveal,copy" });
    expect(ok.ok).toBe(true);
    expect(ok.grant.capabilities).toEqual(["reveal", "copy"]);
  });

  it("blocks self-grants, own-group grants and capability escalation", () => {
    const actorGrants = [g({ capabilities: ["manage_access", "reveal"] })];
    const target = { kind: "collection", collectionId: 1 };
    const base = { actorUserId: 1, actorGrants, actorGroupIds: [7], target };
    expect(checkGrantAuthority({ ...base, grant: { principalType: "user", userId: 1, effect: "allow", capabilities: ["reveal"], scope: "collection" } }).ok).toBe(false);
    expect(checkGrantAuthority({ ...base, grant: { principalType: "group", groupId: 7, effect: "allow", capabilities: ["reveal"], scope: "collection" } }).ok).toBe(false);
    expect(checkGrantAuthority({ ...base, grant: { principalType: "user", userId: 2, effect: "allow", capabilities: ["copy"], scope: "collection" } }).ok).toBe(false);
    expect(checkGrantAuthority({ ...base, grant: { principalType: "user", userId: 2, effect: "allow", capabilities: ["reveal"], scope: "collection" } }).ok).toBe(true);
    expect(checkGrantAuthority({ ...base, grant: { principalType: "user", userId: 2, effect: "allow", capabilities: ["list"], scope: "vault" } }).ok).toBe(false);
  });

  it("holdsAnywhere is menu-only and respects vault-level deny", () => {
    expect(holdsAnywhere([g({ capabilities: ["view_audit"] })], "view_audit")).toBe(true);
    expect(holdsAnywhere([g({ capabilities: ["view_audit"] }), g({ scope: "vault", effect: "deny", capabilities: ["view_audit"] })], "view_audit")).toBe(false);
  });
});

describe("credential vault audit", () => {
  it("drops anything that could be a secret", () => {
    const clean = sanitiseAuditMetadata({
      field: "password",
      password: "x",
      newPassword: "y",
      apiKey: "z",
      token: "t",
      value: "v",
      privateKey: "k",
      recoveryCodes: "c",
      sessionId: "s",
      name: "Instagram",
      capabilities: ["reveal"],
      nested: { password: "x" },
    });
    expect(clean).toEqual({ field: "password", name: "Instagram", capabilities: ["reveal"] });
  });

  it("chains hashes so edits are detectable", () => {
    const e1 = { eventId: 1, occurredAt: new Date("2026-01-01T00:00:00.000Z"), eventType: "a", outcome: "success", metadata: null, prevHash: GENESIS_HASH };
    e1.hash = chainHash(e1.prevHash, e1);
    const e2 = { eventId: 2, occurredAt: new Date("2026-01-01T00:00:01.000Z"), eventType: "b", outcome: "success", metadata: '{"x":1}', prevHash: e1.hash };
    e2.hash = chainHash(e2.prevHash, e2);
    expect(verifyChain([e1, e2]).ok).toBe(true);
    expect(verifyChain([e1, { ...e2, outcome: "failure" }]).ok).toBe(false);
    expect(verifyChain([{ ...e1, eventType: "z" }, e2]).brokenAtEventId).toBe(1);
  });
});

describe("credential vault challenges and settings", () => {
  it("tokens are 256-bit, hashed, and well-formed", () => {
    const t = generateChallengeToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(isWellFormedToken(`${t}x`)).toBe(false);
    expect(hashChallengeToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChallengeToken(t)).not.toContain(t);
    expect(hashSessionId("")).toBeNull();
  });

  it("never lets a challenge live longer than 30 seconds", () => {
    expect(clampChallengeTtl(3600)).toBe(MAX_CHALLENGE_TTL_SECONDS);
    expect(clampChallengeTtl("abc")).toBe(MAX_CHALLENGE_TTL_SECONDS);
    expect(clampChallengeTtl(1)).toBe(10);
    expect(resolveSettings({ challengeTtlSeconds: "999", revealSeconds: "0" })).toMatchObject({ challengeTtlSeconds: 30, revealSeconds: 5 });
  });

  it("maps actions to capabilities", () => {
    expect(requiredCapabilitiesFor("copy")).toEqual(["copy"]);
    expect(requiredCapabilitiesFor("reveal_version")).toEqual(["reveal", "view_history"]);
    expect(requiredCapabilitiesFor("export")).toBeNull();
  });

  it("normalises settings forms", () => {
    const rows = normaliseSettingsForm({ revealSeconds: "45", requireDedicatedVaultPassword: "on" });
    expect(rows.revealSeconds).toBe("45");
    expect(rows.requireDedicatedVaultPassword).toBe("1");
    expect(rows.notifyAccessRequested).toBe("0");
  });
});

describe("credential vault forms", () => {
  it("splits metadata from secrets and requires a secret on create", () => {
    const parsed = parseCredentialForm({ type: "login", name: "IG", collectionId: "1", url: "instagram.com", username: "cfc", secret_password: "pw" });
    expect(parsed.ok).toBe(true);
    expect(parsed.meta.url).toBe("https://instagram.com/");
    expect(parsed.secretChanges.set).toEqual({ password: "pw" });
    expect(JSON.stringify(parsed.meta)).not.toContain('"pw"');
    expect(parseCredentialForm({ type: "login", name: "IG", collectionId: "1" }).ok).toBe(false);
  });

  it("rejects non-http links", () => {
    expect(normaliseUrl("javascript:alert(1)")).toEqual({ error: expect.any(String) });
    expect(normaliseUrl("data:text/html,x")).toEqual({ error: expect.any(String) });
  });

  it("keeps blank secrets on edit, clears on request, handles secret custom fields", () => {
    const parsed = parseCredentialForm(
      {
        name: "IG",
        collectionId: "1",
        secret_password: "",
        clear_totpSecret: "1",
        custom_label: ["Backup PIN", "Note"],
        custom_value: ["1234", "public"],
        custom_key: ["", ""],
        custom_secret: ["0"],
      },
      { existingType: "login", existingFieldNames: ["password", "totpSecret", "custom:old_0"] }
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.secretChanges.set).toEqual({ "custom:backup_pin_0": "1234" });
    expect(parsed.secretChanges.clear.sort()).toEqual(["custom:old_0", "totpSecret"]);
    expect(parsed.meta.details.customFields).toEqual([
      { key: "backup_pin_0", label: "Backup PIN", secret: true },
      { key: "note_1", label: "Note", secret: false, value: "public" },
    ]);
    expect(mergeSecretPayload({ password: "a", totpSecret: "b" }, parsed.secretChanges)).toEqual({ password: "a", "custom:backup_pin_0": "1234" });
  });

  it("validates field names per type", () => {
    expect(isSecretFieldName("login", "password")).toBe(true);
    expect(isSecretFieldName("login", "apiKey")).toBe(false);
    expect(isSecretFieldName("login", "custom:abc_1")).toBe(true);
    expect(isSecretFieldName("login", "custom:../x")).toBe(false);
  });

  it("validates collections", () => {
    expect(validateCollectionForm({ name: "X", colour: "red" }).ok).toBe(false);
    expect(validateCollectionForm({ name: "X", icon: "fa-solid fa-code\" onmouseover=\"x" }).ok).toBe(false);
    expect(validateCollectionForm({ name: "X", icon: "fa-solid fa-code", colour: "#aabbcc" }).ok).toBe(true);
  });
});

describe("vault passwords", () => {
  it("enforces a sensible policy", () => {
    expect(vaultPasswordProblem("short")).toMatch(/12/);
    expect(vaultPasswordProblem("aaaaaaaaaaaaaaaa")).toMatch(/guess/);
    expect(vaultPasswordProblem("benrobson-long-passphrase-1", { username: "benrobson" })).toMatch(/username/);
    expect(vaultPasswordProblem("correct horse battery staple 9")).toBeNull();
  });

  it("stores Argon2id verifiers only", async () => {
    const v = await hashVaultPassword("correct horse battery staple 9");
    expect(v.startsWith("$argon2id$v=19$")).toBe(true);
    expect(v).toMatch(/m=19456/);
    expect(v).toMatch(/t=2/);
    expect(v).toMatch(/p=1/);
    expect(await verifyVaultPassword(v, "correct horse battery staple 9")).toBe(true);
    expect(await verifyVaultPassword(v, "wrong")).toBe(false);
    expect(await verifyVaultPassword("$2b$10$notargon", "x")).toBe(false);
  });
});

describe("browser-side invariants", () => {
  it("the service worker never intercepts fetches, so vault responses cannot be cached offline", async () => {
    const { readFileSync } = await import("node:fs");
    const sw = readFileSync(new URL("../../assets/sw.js", import.meta.url), "utf8");
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(sw).not.toMatch(/caches\.open|cache\.put/);
  });

  it("the vault script never touches persistent browser storage", async () => {
    const { readFileSync } = await import("node:fs");
    const js = readFileSync(new URL("../../assets/js/credentialVault.js", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(js).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML\s*=/);
  });
});

describe("token randomness sanity", () => {
  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateChallengeToken()));
    expect(seen.size).toBe(200);
    expect(crypto.randomBytes).toBeTypeOf("function");
  });
});
