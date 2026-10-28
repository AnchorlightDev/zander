/**
 * End-to-end tests of the Credential Vault service against a real MySQL /
 * MariaDB database. They create and drop their own scratch database.
 *
 * Skipped unless CREDENTIAL_VAULT_TEST_DATABASE_URL points at a server where
 * the user may CREATE/DROP DATABASE, e.g.
 *   CREDENTIAL_VAULT_TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3306 npx vitest run tests/integration/credentialVault.db.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const TEST_URL = process.env.CREDENTIAL_VAULT_TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

suite("Credential Vault (database)", () => {
  let mysql;
  let bcrypt;
  let admin; // root pool without a database
  let pool;
  let dbName;
  let store;
  let svc;
  let crypt;
  let clock;
  let notifications;
  let destroyedSessions;
  let users;

  const SESSION = "session-id-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const reqInfo = (userId, extra = {}) => ({ ip: "203.0.113.5", userAgent: "vitest", sessionId: `${SESSION}-${userId}`, ...extra });

  async function makeUser(username, { password = null, disabled = false } = {}) {
    const hash = password ? await bcrypt.hash(password, 4) : null;
    const [r] = await pool.query(
      `INSERT INTO users (uuid, username, password_hash, account_disabled) VALUES (?, ?, ?, ?)`,
      [crypto.randomUUID(), username, hash, disabled ? 1 : 0]
    );
    return r.insertId;
  }

  async function actor(userId, extra = {}) {
    return svc.loadActor(userId, reqInfo(userId, extra));
  }

  async function grant(userId, scope, capabilities, extra = {}) {
    return store.insertGrant({ scope, principalType: "user", userId, effect: "allow", capabilities, ...extra }, null);
  }

  function form(overrides = {}) {
    return {
      ok: true,
      meta: {
        type: "login",
        name: "Instagram",
        collectionId: 1,
        url: "https://instagram.com/",
        username: "cfc-official",
        email: null,
        description: "Main account",
        details: { customFields: [] },
        tags: ["social"],
        ownerUserId: null,
        ownerUsername: null,
        isRequestable: false,
        expiresAt: null,
        rotateEveryDays: null,
        nextRotationAt: null,
        ...overrides.meta,
      },
      secretChanges: { set: { password: "Insta-Pa55word-UNIQUE-1" }, clear: [], ...overrides.secretChanges },
    };
  }

  async function reveal(userId, credentialId, password, { action = "reveal", field = "password", versionId = null, info = {} } = {}) {
    const a = await actor(userId, info);
    const ch = await svc.startChallenge(a, { credentialId, action, field, versionId });
    return svc.verifyChallenge(userId, { challengeToken: ch.challengeToken, password }, reqInfo(userId, info));
  }

  beforeAll(async () => {
    mysql = (await import("mysql2/promise")).default;
    bcrypt = (await import("bcrypt")).default;
    const url = new URL(TEST_URL);
    const conn = {
      host: url.hostname,
      port: Number(url.port) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      timezone: "Z",
      multipleStatements: true,
    };
    admin = await mysql.createConnection(conn);
    dbName = `zander_cv_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${dbName}\``);
    await admin.query(`CREATE TABLE users (
      userId INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      uuid VARCHAR(36) NOT NULL UNIQUE,
      username VARCHAR(16) NOT NULL,
      password_hash VARCHAR(255) NULL,
      account_disabled TINYINT(1) NOT NULL DEFAULT 0,
      is_placeholder TINYINT(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const migration = readFileSync(new URL("../../prisma/migrations/0077_credential_vault/migration.sql", import.meta.url), "utf8");
    await admin.query(migration);

    pool = mysql.createPool({ ...conn, multipleStatements: false, database: dbName, connectionLimit: 10 });
    store = await import("../../controllers/credentialVaultController.js");
    store.setVaultDatabase(pool);
    crypt = await import("../../lib/credentialVault/crypto.mjs");
    svc = await import("../../services/credentialVaultService.js");
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await admin.end();
    }
  });

  beforeEach(async () => {
    clock = new Date();
    notifications = [];
    destroyedSessions = [];
    const k1 = crypt.generateKek();
    svc.configureVaultServiceForTests({
      keyProvider: new crypt.EnvKeyProvider({ keks: `k1:${k1}`, activeKekId: "k1" }),
      now: () => clock,
      notify: async (n) => notifications.push(n),
      destroySessionsForUser: async (id) => {
        destroyedSessions.push(id);
        return 2;
      },
    });
    // Fresh vault per test: wipe everything except seeds.
    for (const t of [
      "credentialFavourites",
      "credentialRotationTasks",
      "credentialChallenges",
      "credentialAccessRequests",
      "credentialGrants",
      "credentialGroupMembers",
      "credentialSecretVersions",
      "credentialKeys",
      "credentials",
      "credentialVaultPasswords",
      "credentialVaultSettings",
      "credentialAuditEvents",
    ]) {
      await pool.query(`DELETE FROM ${t}`);
    }
    await pool.query(`UPDATE credentialAuditHead SET lastEventId = NULL, lastHash = ?, anchorEventId = 0, anchorHash = ?`, ["0".repeat(64), "0".repeat(64)]);
    await pool.query(`UPDATE credentialVaults SET wrappedFingerprintKey = NULL, fingerprintKekId = NULL`);
    await pool.query(`DELETE FROM users`);
    svc.invalidateSettingsCache();

    users = {
      admin: await makeUser("vaultadmin", { password: "Admin-Password-1" }),
      editor: await makeUser("editor", { password: "Editor-Password-1" }),
      reader: await makeUser("reader", { password: "Reader-Password-1" }),
      outsider: await makeUser("outsider", { password: "Outsider-Password-1" }),
      discord: await makeUser("discordonly"),
    };
    await grant(users.admin, "vault", ["manage_vault", "manage_collections", "view_audit", "approve_requests"]);
    await grant(users.editor, "collection", ["create", "edit", "reveal", "copy", "view_history", "delete"], { collectionId: 1 });
    await grant(users.reader, "collection", ["reveal"], { collectionId: 1 });
  });

  async function createInstagram(overrides) {
    const a = await actor(users.editor);
    return svc.createCredential(a, form(overrides));
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  it("never stores a secret value in plaintext anywhere in the database", async () => {
    const id = await createInstagram();
    await reveal(users.editor, id, "Editor-Password-1");
    const [tables] = await pool.query(`SHOW TABLES`);
    for (const row of tables) {
      const table = Object.values(row)[0];
      const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
      const dump = JSON.stringify(rows, (k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString("latin1") : v));
      expect(dump, `table ${table}`).not.toContain("Insta-Pa55word-UNIQUE-1");
    }
  });

  it("binds ciphertext to its credential: swapping rows fails to decrypt", async () => {
    const a = await createInstagram();
    const b = await createInstagram({ meta: { name: "Facebook" }, secretChanges: { set: { password: "Facebook-Secret-99" } } });
    const [[va]] = await pool.query(`SELECT ciphertext FROM credentialSecretVersions WHERE credentialId = ?`, [a]);
    await pool.query(`UPDATE credentialSecretVersions SET ciphertext = ? WHERE credentialId = ?`, [va.ciphertext, b]);
    await expect(reveal(users.editor, b, "Editor-Password-1")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Mandatory reauthentication
  // -------------------------------------------------------------------------

  it("reveals exactly once per verified challenge", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const ch = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    expect(ch.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = await svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader));
    expect(first.value).toBe("Insta-Pa55word-UNIQUE-1");
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("a second reveal a moment later needs a new challenge", async () => {
    const id = await createInstagram();
    await reveal(users.reader, id, "Reader-Password-1");
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM credentialChallenges WHERE status = 'pending'`);
    expect(Number(n)).toBe(0);
    const again = await reveal(users.reader, id, "Reader-Password-1");
    expect(again.value).toBe("Insta-Pa55word-UNIQUE-1");
    const [[{ c }]] = await pool.query(`SELECT COUNT(*) AS c FROM credentialChallenges WHERE outcome = 'succeeded'`);
    expect(Number(c)).toBe(2);
  });

  it("copy needs the copy capability and its own challenge", async () => {
    const id = await createInstagram();
    const reader = await actor(users.reader);
    await expect(svc.startChallenge(reader, { credentialId: id, action: "copy", field: "password" })).rejects.toMatchObject({ code: "forbidden" });
    const res = await reveal(users.editor, id, "Editor-Password-1", { action: "copy" });
    expect(res.action).toBe("copy");
    expect(res.value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  it("a challenge for one credential cannot reveal another", async () => {
    const insta = await createInstagram();
    await createInstagram({ meta: { name: "GitHub" }, secretChanges: { set: { password: "GitHub-Secret-77" } } });
    const res = await reveal(users.reader, insta, "Reader-Password-1");
    expect(res.value).toBe("Insta-Pa55word-UNIQUE-1");
    const [[row]] = await pool.query(`SELECT credentialId, field, action FROM credentialChallenges LIMIT 1`);
    expect(row).toMatchObject({ credentialId: insta, field: "password", action: "reveal" });
  });

  it("a wrong password burns the challenge (one guess per token)", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const ch = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "wrong" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "verification_failed" });
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("expired challenges are rejected", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const ch = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    expect(ch.expiresInSeconds).toBeLessThanOrEqual(30);
    clock = new Date(clock.getTime() + 31000);
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("challenges are bound to the session and the user", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const ch = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, { sessionId: "another-session-zzzzzzzzzz" })
    ).rejects.toMatchObject({ code: "verification_failed" });
    const ch2 = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    await expect(
      svc.verifyChallenge(users.editor, { challengeToken: ch2.challengeToken, password: "Editor-Password-1" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "verification_failed" });
    const [events] = await pool.query(`SELECT eventType FROM credentialAuditEvents WHERE eventType = 'suspicious_activity'`);
    expect(events.length).toBe(1);
  });

  it("concurrent verifications of one token succeed at most once", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const ch = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader))
      )
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("revoking access between challenge and verification denies the secret", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const ch = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    await pool.query(`UPDATE credentialGrants SET revokedAt = ? WHERE userId = ?`, [new Date(), users.reader]);
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("deleting the credential revokes pending challenges", async () => {
    const id = await createInstagram();
    const reader = await actor(users.reader);
    const ch = await svc.startChallenge(reader, { credentialId: id, action: "reveal", field: "password" });
    await svc.deleteCredential(await actor(users.editor), id);
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("a suspended account cannot reveal", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const ch = await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" });
    await pool.query(`UPDATE users SET account_disabled = 1 WHERE userId = ?`, [users.reader]);
    await expect(
      svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "Reader-Password-1" }, reqInfo(users.reader))
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(actor(users.reader)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("administrators cannot reveal without an explicit reveal grant", async () => {
    const id = await createInstagram();
    const a = await actor(users.admin);
    expect(a.vaultCaps.has("manage_vault")).toBe(true);
    await expect(svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("outsiders get the same answer for a real and a missing credential", async () => {
    const id = await createInstagram();
    const a = await actor(users.outsider);
    const real = await svc.getCredentialForActor(a, id).catch((e) => e);
    const missing = await svc.getCredentialForActor(a, 999999).catch((e) => e);
    expect(real.code).toBe("not_found");
    expect(missing.code).toBe("not_found");
    expect(real.message).toBe(missing.message);
    const list = await svc.listCredentialsForActor(a, {});
    expect(list).toHaveLength(0);
  });

  it("locks verification after repeated failures and notifies administrators", async () => {
    const id = await createInstagram();
    for (let i = 0; i < 5; i += 1) {
      await expect(reveal(users.reader, id, "nope")).rejects.toBeInstanceOf(svc.VaultError);
    }
    await expect(actor(users.reader).then((a) => svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" }))).rejects.toMatchObject({
      code: "locked",
    });
    expect(notifications.some((n) => n.eventKey === "notifySuspicious")).toBe(true);
    clock = new Date(clock.getTime() + 16 * 60000);
    const res = await reveal(users.reader, id, "Reader-Password-1");
    expect(res.value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  // -------------------------------------------------------------------------
  // Factors
  // -------------------------------------------------------------------------

  it("Discord-only staff enrol only with a one-time code from another administrator", async () => {
    const id = await createInstagram();
    await grant(users.discord, "credential", ["reveal"], { credentialId: id });
    const a = await actor(users.discord);
    await expect(svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" })).rejects.toMatchObject({
      code: "enrolment_required",
    });
    const pw = "correct horse battery staple 9";
    // Being signed in is not enough: no code, no vault password.
    await expect(svc.enrolVaultPassword(a, { password: pw, confirm: pw, enrolmentCode: "" })).rejects.toMatchObject({ code: "verification_failed" });
    await expect(svc.enrolVaultPassword(a, { password: "short", confirm: "short", enrolmentCode: "x" })).rejects.toMatchObject({ code: "invalid" });
    const adminActor = await actor(users.admin);
    await expect(svc.issueEnrolmentCode(adminActor, { username: "vaultadmin" })).rejects.toMatchObject({ code: "forbidden" });
    const issued = await svc.issueEnrolmentCode(adminActor, { username: "discordonly" });
    expect(issued.code).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const [[stored]] = await pool.query(`SELECT enrolmentCodeHash FROM credentialVaultPasswords WHERE userId = ?`, [users.discord]);
    expect(stored.enrolmentCodeHash).not.toContain(issued.code.replace(/-/g, ""));
    await expect(svc.enrolVaultPassword(a, { password: pw, confirm: pw, enrolmentCode: "AAAAA-BBBBB-CCCCC-DDDDD" })).rejects.toMatchObject({ code: "verification_failed" });
    await svc.enrolVaultPassword(a, { password: pw, confirm: pw, enrolmentCode: issued.code.toLowerCase() });
    const [[row]] = await pool.query(`SELECT verifier, enrolmentCodeHash FROM credentialVaultPasswords WHERE userId = ?`, [users.discord]);
    expect(row.verifier.startsWith("$argon2id$")).toBe(true);
    expect(row.verifier).not.toContain("correct horse");
    expect(row.enrolmentCodeHash).toBeNull();
    const res = await reveal(users.discord, id, pw);
    expect(res.value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  it("an enrolment code works once and expires", async () => {
    const adminActor = await actor(users.admin);
    const a = await actor(users.discord);
    const pw = "correct horse battery staple 9";
    const first = await svc.issueEnrolmentCode(adminActor, { username: "discordonly" });
    clock = new Date(clock.getTime() + 25 * 3600000);
    await expect(svc.enrolVaultPassword(a, { password: pw, confirm: pw, enrolmentCode: first.code })).rejects.toMatchObject({ code: "verification_failed" });
    const second = await svc.issueEnrolmentCode(adminActor, { username: "discordonly" });
    await svc.enrolVaultPassword(a, { password: pw, confirm: pw, enrolmentCode: second.code });
    await svc.resetVaultPasswordFor(adminActor, users.discord);
    await expect(svc.enrolVaultPassword(a, { password: pw, confirm: pw, enrolmentCode: second.code })).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("password-account staff prove their Zander password to enrol, and no oracle leaks before that", async () => {
    const id = await createInstagram();
    await store.saveSettings({ requireDedicatedVaultPassword: "1" }, users.admin);
    svc.invalidateSettingsCache();
    const a = await actor(users.reader);
    await expect(svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" })).rejects.toMatchObject({
      code: "enrolment_required",
    });
    // Wrong account password: rejected before the new password is even looked at,
    // so "is this my account password?" cannot be tested through the policy check.
    await expect(
      svc.enrolVaultPassword(a, { password: "Reader-Password-1-long", confirm: "Reader-Password-1-long", accountPassword: "guess" })
    ).rejects.toMatchObject({ code: "verification_failed" });
    await expect(
      svc.enrolVaultPassword(a, { password: "Reader-Password-1", confirm: "Reader-Password-1", accountPassword: "Reader-Password-1" })
    ).rejects.toMatchObject({ code: "invalid" });
    await svc.enrolVaultPassword(a, { password: "a different long passphrase 42", confirm: "a different long passphrase 42", accountPassword: "Reader-Password-1" });
    await expect(reveal(users.reader, id, "Reader-Password-1")).rejects.toMatchObject({ code: "verification_failed" });
    const res = await reveal(users.reader, id, "a different long passphrase 42");
    expect(res.value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  it("a vault administrator can reset someone else's vault password but not their own", async () => {
    const adminActor = await actor(users.admin);
    const issued = await svc.issueEnrolmentCode(adminActor, { username: "discordonly" });
    await svc.enrolVaultPassword(await actor(users.discord), { password: "correct horse battery staple 9", confirm: "correct horse battery staple 9", enrolmentCode: issued.code });
    await expect(svc.resetVaultPasswordFor(adminActor, users.admin)).rejects.toMatchObject({ code: "forbidden" });
    await svc.resetVaultPasswordFor(adminActor, users.discord);
    const [[row]] = await pool.query(`SELECT verifier FROM credentialVaultPasswords WHERE userId = ?`, [users.discord]);
    expect(row.verifier).toBeNull();
  });

  it("parallel wrong guesses cannot exceed the lockout limit", async () => {
    const id = await createInstagram();
    const a = await actor(users.reader);
    const challenges = [];
    for (let i = 0; i < 12; i += 1) challenges.push(await svc.startChallenge(a, { credentialId: id, action: "reveal", field: "password" }));
    const results = await Promise.allSettled(
      challenges.map((ch) => svc.verifyChallenge(users.reader, { challengeToken: ch.challengeToken, password: "wrong" }, reqInfo(users.reader)))
    );
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM credentialAuditEvents WHERE eventType = 'reauth_failed' AND outcome = 'failure'`);
    expect(Number(n)).toBeLessThanOrEqual(5);
    expect(results.some((r) => r.status === "rejected" && r.reason.code === "locked")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  it("nobody can grant themselves access or approve their own request", async () => {
    const id = await createInstagram();
    const editor = await actor(users.editor);
    await expect(
      svc.grantAccess(editor, { scope: "credential", credentialId: id, principalType: "user", userId: users.editor, capabilities: ["reveal"] })
    ).rejects.toMatchObject({ code: "forbidden" });
    const adminActor = await actor(users.admin);
    await expect(
      svc.grantAccess(adminActor, { scope: "vault", principalType: "user", userId: users.admin, capabilities: ["reveal"] })
    ).rejects.toMatchObject({ code: "forbidden" });

    await pool.query(`UPDATE credentials SET isRequestable = 1 WHERE credentialId = ?`, [id]);
    const outsider = await actor(users.outsider);
    const requestId = await svc.submitAccessRequest(outsider, { scope: "credential", targetId: id, capabilities: ["reveal"], reason: "Posting the event announcement", durationHours: 4 });
    // Give the outsider approve rights to prove they still cannot approve themselves.
    await grant(users.outsider, "vault", ["approve_requests"]);
    await expect(svc.decideAccessRequest(await actor(users.outsider), requestId, { approve: true })).rejects.toMatchObject({ code: "forbidden" });
    await svc.decideAccessRequest(adminActor, requestId, { approve: true, durationHours: 4 });
    const res = await reveal(users.outsider, id, "Outsider-Password-1");
    expect(res.value).toBe("Insta-Pa55word-UNIQUE-1");
    clock = new Date(clock.getTime() + 5 * 3600000);
    await expect(reveal(users.outsider, id, "Outsider-Password-1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("deny through a group overrides a direct allow, and group changes apply immediately", async () => {
    const id = await createInstagram();
    const adminActor = await actor(users.admin);
    const groupId = await svc.createGroup(adminActor, { name: "Restricted", description: "" });
    await svc.grantAccess(adminActor, { scope: "collection", collectionId: 1, principalType: "group", groupId, effect: "deny", capabilities: ["reveal"] });
    await expect(reveal(users.reader, id, "Reader-Password-1")).resolves.toBeTruthy();
    await svc.addGroupMember(adminActor, groupId, { username: "reader" });
    await expect(reveal(users.reader, id, "Reader-Password-1")).rejects.toBeInstanceOf(svc.VaultError);
    await svc.removeGroupMember(adminActor, groupId, users.reader);
    await expect(reveal(users.reader, id, "Reader-Password-1")).resolves.toBeTruthy();
  });

  it("staff cannot change their own group membership", async () => {
    const adminActor = await actor(users.admin);
    const groupId = await svc.createGroup(adminActor, { name: "Admins", description: "" });
    await expect(svc.addGroupMember(adminActor, groupId, { username: "vaultadmin" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("without manage_vault you can only grant capabilities you hold", async () => {
    const id = await createInstagram();
    await grant(users.reader, "credential", ["manage_access"], { credentialId: id });
    const reader = await actor(users.reader);
    await expect(
      svc.grantAccess(reader, { scope: "credential", credentialId: id, principalType: "user", userId: users.outsider, capabilities: ["copy"] })
    ).rejects.toMatchObject({ code: "forbidden" });
    await svc.grantAccess(reader, { scope: "credential", credentialId: id, principalType: "user", userId: users.outsider, capabilities: ["reveal"] });
  });

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------

  it("keeps encrypted history; old versions need history + reveal and a challenge", async () => {
    const id = await createInstagram();
    const editor = await actor(users.editor);
    await svc.updateCredential(editor, id, form({ secretChanges: { set: { password: "Second-Version-Pass-2" } } }));
    const history = await svc.versionHistory(editor, id);
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(history.versions[0].changedFields).toEqual(["password"]);
    const v1 = history.versions.find((v) => v.version === 1);
    const old = await reveal(users.editor, id, "Editor-Password-1", { action: "reveal_version", versionId: v1.versionId });
    expect(old.value).toBe("Insta-Pa55word-UNIQUE-1");
    const current = await reveal(users.editor, id, "Editor-Password-1");
    expect(current.value).toBe("Second-Version-Pass-2");
    await expect(
      actor(users.reader).then((a) => svc.startChallenge(a, { credentialId: id, action: "reveal_version", field: "password", versionId: v1.versionId }))
    ).rejects.toBeInstanceOf(svc.VaultError);
    await reveal(users.editor, id, "Editor-Password-1", { action: "restore_version", versionId: v1.versionId, field: "*" });
    const restored = await reveal(users.editor, id, "Editor-Password-1");
    expect(restored.value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  it("an edit that leaves secret fields blank keeps them", async () => {
    const id = await createInstagram();
    const editor = await actor(users.editor);
    await svc.updateCredential(editor, id, form({ meta: { name: "Instagram (main)" }, secretChanges: { set: {}, clear: [] } }));
    const history = await svc.versionHistory(editor, id);
    expect(history.versions).toHaveLength(1);
    expect((await reveal(users.editor, id, "Editor-Password-1")).value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it("audits reveals without secret values and detects tampering", async () => {
    const id = await createInstagram();
    await reveal(users.reader, id, "Reader-Password-1");
    await expect(reveal(users.reader, id, "bad-password")).rejects.toBeTruthy();
    const [rows] = await pool.query(`SELECT eventType, outcome, metadata FROM credentialAuditEvents ORDER BY eventId`);
    const types = rows.map((r) => r.eventType);
    expect(types).toEqual(expect.arrayContaining(["credential_created", "reauth_succeeded", "secret_revealed", "reauth_failed"]));
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain("Insta-Pa55word");
    expect(blob).not.toContain("Reader-Password-1");
    expect(blob).not.toContain("bad-password");

    const adminActor = await actor(users.admin);
    expect((await svc.verifyAuditChain(adminActor)).ok).toBe(true);
    await pool.query(`UPDATE credentialAuditEvents SET outcome = 'success' WHERE eventType = 'reauth_failed'`);
    const tampered = await svc.verifyAuditChain(adminActor);
    expect(tampered.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Offboarding and health
  // -------------------------------------------------------------------------

  it("offboarding revokes access, ends sessions and opens rotation tasks", async () => {
    const id = await createInstagram();
    await reveal(users.reader, id, "Reader-Password-1");
    const adminActor = await actor(users.admin);
    const result = await svc.offboardStaff(adminActor, users.reader, { endSessions: true });
    expect(result.grantsRevoked).toBe(1);
    expect(result.tasksOpened).toBe(1);
    expect(destroyedSessions).toEqual([users.reader]);
    await expect(reveal(users.reader, id, "Reader-Password-1")).rejects.toBeInstanceOf(svc.VaultError);
    const tasks = await svc.rotationTasks(adminActor);
    expect(tasks.map((t) => t.credentialId)).toEqual([id]);
    // Rotating closes the task.
    await svc.updateCredential(await actor(users.editor), id, { ...form({ secretChanges: { set: { password: "Rotated-Pass-3" } } }), markRotated: true });
    expect(await svc.rotationTasks(adminActor)).toHaveLength(0);
    await expect(svc.offboardStaff(adminActor, users.admin)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("moving needs manage access on both sides and still cannot widen the mover's own access", async () => {
    const id = await createInstagram();
    // A user who can edit in collection 1 but only reveal in collection 2.
    const mover = await makeUser("mover", { password: "Mover-Password-1" });
    await grant(mover, "collection", ["edit"], { collectionId: 1 });
    await grant(mover, "collection", ["create", "reveal", "edit"], { collectionId: 2 });
    const m = await actor(mover);
    await expect(svc.startChallenge(m, { credentialId: id, action: "reveal", field: "password" })).rejects.toBeInstanceOf(svc.VaultError);
    await expect(svc.updateCredential(m, id, form({ meta: { collectionId: 2 }, secretChanges: { set: {}, clear: [] } }))).rejects.toMatchObject({
      code: "forbidden",
    });
    const [[row]] = await pool.query(`SELECT collectionId FROM credentials WHERE credentialId = ?`, [id]);
    expect(row.collectionId).toBe(1);
    // Even with manage_access everywhere, a move that would hand the mover reveal is refused.
    await grant(mover, "collection", ["manage_access"], { collectionId: 1 });
    await grant(mover, "collection", ["manage_access"], { collectionId: 2 });
    await expect(svc.updateCredential(await actor(mover), id, form({ meta: { collectionId: 2 }, secretChanges: { set: {}, clear: [] } }))).rejects.toMatchObject({
      code: "forbidden",
    });
    // The editor (manage_access on both, same rights in both) can move it.
    await grant(users.editor, "collection", ["manage_access"], { collectionId: 1 });
    await grant(users.editor, "collection", ["manage_access", "create", "edit", "reveal", "copy", "view_history", "delete"], { collectionId: 2 });
    await svc.updateCredential(await actor(users.editor), id, form({ meta: { collectionId: 2 }, secretChanges: { set: {}, clear: [] } }));
  });

  it("approvers can only approve capabilities they hold, and cannot extend the duration", async () => {
    const id = await createInstagram();
    await pool.query(`UPDATE credentials SET isRequestable = 1 WHERE credentialId = ?`, [id]);
    const approver = await makeUser("approver", { password: "Approver-Password-1" });
    await grant(approver, "collection", ["approve_requests", "reveal"], { collectionId: 1 });
    const outsider = await actor(users.outsider);
    const r1 = await svc.submitAccessRequest(outsider, { scope: "credential", targetId: id, capabilities: ["copy"], reason: "Need to paste it into the scheduler", durationHours: 4 });
    await expect(svc.decideAccessRequest(await actor(approver), r1, { approve: true, durationHours: 4 })).rejects.toMatchObject({ code: "forbidden" });
    await svc.cancelAccessRequest(outsider, r1);
    const r2 = await svc.submitAccessRequest(outsider, { scope: "credential", targetId: id, capabilities: ["reveal"], reason: "Need to post the event update", durationHours: 4 });
    await expect(svc.decideAccessRequest(await actor(approver), r2, { approve: true, durationHours: "0" })).rejects.toMatchObject({ code: "invalid" });
    await expect(svc.decideAccessRequest(await actor(approver), r2, { approve: true, durationHours: 24 })).rejects.toMatchObject({ code: "invalid" });
    await svc.decideAccessRequest(await actor(approver), r2, { approve: true, durationHours: 1 });
    const [[g]] = await pool.query(`SELECT expiresAt FROM credentialGrants WHERE requestId = ?`, [r2]);
    expect(new Date(g.expiresAt).getTime() - clock.getTime()).toBeLessThanOrEqual(3600000 + 1000);
  });

  it("only someone who holds a denied capability can lift the deny", async () => {
    const id = await createInstagram();
    const adminActor = await actor(users.admin);
    const denyId = await svc.grantAccess(adminActor, { scope: "credential", credentialId: id, principalType: "user", userId: users.reader, effect: "deny", capabilities: ["reveal"] });
    const manager = await makeUser("manager", { password: "Manager-Password-1" });
    await grant(manager, "collection", ["manage_access"], { collectionId: 1 });
    await expect(svc.revokeAccess(await actor(manager), denyId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(reveal(users.reader, id, "Reader-Password-1")).rejects.toBeInstanceOf(svc.VaultError);
    // The same manager may still remove someone's access (an allow grant).
    const [[readerGrant]] = await pool.query(`SELECT grantId FROM credentialGrants WHERE userId = ? AND effect = 'allow'`, [users.reader]);
    await svc.revokeAccess(await actor(manager), readerGrant.grantId);
  });

  it("lifting a deny on view needs every capability the deny removed", async () => {
    const id = await createInstagram();
    const adminActor = await actor(users.admin);
    const denyId = await svc.grantAccess(adminActor, { scope: "credential", credentialId: id, principalType: "user", userId: users.reader, effect: "deny", capabilities: ["view"] });
    const manager = await makeUser("manager2", { password: "Manager-Password-1" });
    await grant(manager, "collection", ["manage_access", "view"], { collectionId: 1 });
    await expect(svc.revokeAccess(await actor(manager), denyId)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a counter stranded at the limit becomes an expiring lock, not a permanent one", async () => {
    const id = await createInstagram();
    await pool.query(`INSERT INTO credentialVaultPasswords (userId, failedAttempts) VALUES (?, 5)`, [users.reader]);
    await expect(reveal(users.reader, id, "Reader-Password-1")).rejects.toMatchObject({ code: "locked" });
    const [[row]] = await pool.query(`SELECT lockedUntil, failedAttempts FROM credentialVaultPasswords WHERE userId = ?`, [users.reader]);
    expect(row.lockedUntil).not.toBeNull();
    clock = new Date(clock.getTime() + 16 * 60000);
    expect((await reveal(users.reader, id, "Reader-Password-1")).value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  it("list-only users cannot search hidden usernames", async () => {
    await createInstagram({ meta: { username: "secret-handle" } });
    const lister = await makeUser("lister", { password: "Lister-Password-1" });
    await grant(lister, "collection", ["list"], { collectionId: 1 });
    const l = await actor(lister);
    expect(await svc.listCredentialsForActor(l, {})).toHaveLength(1);
    expect(await svc.listCredentialsForActor(l, { q: "secret-han" })).toHaveLength(0);
    expect((await svc.listCredentialsForActor(l, { q: "insta" }))[0].username).toBeNull();
    expect(await svc.listCredentialsForActor(await actor(users.reader), { q: "secret-han" })).toHaveLength(1);
  });

  it("access requests cannot be used to enumerate credential names", async () => {
    const id = await createInstagram({ meta: { name: "Hidden thing" } });
    await pool.query(`UPDATE credentialCollections SET isRequestable = 1 WHERE collectionId = 1`);
    const outsider = await actor(users.outsider);
    await expect(
      svc.submitAccessRequest(outsider, { scope: "credential", targetId: id, capabilities: ["reveal"], reason: "Probing ids for names" })
    ).rejects.toMatchObject({ code: "not_found" });
    await svc.submitAccessRequest(outsider, { scope: "collection", targetId: 1, capabilities: ["list"], reason: "Joining the social team" });
    await pool.query(`UPDATE credentialCollections SET isRequestable = 0 WHERE collectionId = 1`);
  });

  it("detects deleted newest audit events and survives retention purges", async () => {
    const id = await createInstagram();
    await reveal(users.reader, id, "Reader-Password-1");
    const adminActor = await actor(users.admin);
    expect((await svc.verifyAuditChain(adminActor)).ok).toBe(true);
    // Retention trims the oldest events cleanly.
    clock = new Date(clock.getTime() + 1000);
    const removed = await store.purgeAuditBefore(new Date(Date.now() + 60000));
    expect(removed).toBeGreaterThan(0);
    await reveal(users.reader, id, "Reader-Password-1");
    expect((await svc.verifyAuditChain(adminActor)).ok).toBe(true);
    // Deleting the newest event is caught by the head row.
    await pool.query(`DELETE FROM credentialAuditEvents ORDER BY eventId DESC LIMIT 1`);
    expect((await svc.verifyAuditChain(adminActor)).ok).toBe(false);
  });

  it("health flags reuse, weak passwords and missing owners without exposing secrets", async () => {
    await createInstagram({ meta: { ownerUserId: null }, secretChanges: { set: { password: "same-Password-123!" } } });
    await createInstagram({ meta: { name: "Facebook" }, secretChanges: { set: { password: "same-Password-123!" } } });
    await createInstagram({ meta: { name: "Weak" }, secretChanges: { set: { password: "abc" } } });
    const health = await svc.credentialHealth(await actor(users.admin));
    expect(health.reused).toHaveLength(2);
    expect(health.weak.map((r) => r.name)).toContain("Weak");
    expect(JSON.stringify(health)).not.toContain("same-Password");
    expect(JSON.stringify(health)).not.toMatch(/passwordFingerprint/);
  });

  // -------------------------------------------------------------------------
  // Key rotation
  // -------------------------------------------------------------------------

  it("re-wraps data keys under a new KEK without touching ciphertext", async () => {
    const k1 = crypt.generateKek();
    const k2 = crypt.generateKek();
    svc.configureVaultServiceForTests({ keyProvider: new crypt.EnvKeyProvider({ keks: `k1:${k1}`, activeKekId: "k1" }) });
    const id = await createInstagram();
    svc.configureVaultServiceForTests({ keyProvider: new crypt.EnvKeyProvider({ keks: `k1:${k1},k2:${k2}`, activeKekId: "k2" }) });
    const result = await svc.rewrapAllKeys();
    expect(result.rewrapped).toBe(1);
    expect(result.fingerprintRewrapped).toBe(true);
    svc.configureVaultServiceForTests({ keyProvider: new crypt.EnvKeyProvider({ keks: `k2:${k2}`, activeKekId: "k2" }) });
    expect((await reveal(users.reader, id, "Reader-Password-1")).value).toBe("Insta-Pa55word-UNIQUE-1");
  });

  it("refuses to work when no KEK is configured", async () => {
    svc.configureVaultServiceForTests({ keyProvider: null, keyProviderError: "CREDENTIAL_VAULT_KEKS is not set" });
    const editor = await actor(users.editor);
    await expect(svc.createCredential(editor, form())).rejects.toMatchObject({ code: "not_configured" });
  });
});
