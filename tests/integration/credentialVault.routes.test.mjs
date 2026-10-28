/**
 * HTTP-level tests for the Credential Vault: every page renders with the real
 * EJS views, no page contains a secret, secret-bearing responses are not
 * cacheable, and the JSON flow enforces one verification per action.
 *
 * Needs a database, like credentialVault.db.test.mjs:
 *   CREDENTIAL_VAULT_TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3306 npx vitest run tests/integration/credentialVault.routes.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_URL = process.env.CREDENTIAL_VAULT_TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

// The route module reaches databaseController through api/common.js; the vault
// itself uses the injected test pool, so the shared pool is stubbed out.
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: (_sql, _params, cb) => (typeof cb === "function" ? cb(null, []) : undefined) },
  prisma: {},
  isDbHealthy: () => true,
  luckpermsDb: {},
  quickshopDb: {},
  punishmentsDb: {},
  withDeadlockRetry: (fn) => fn(),
}));

vi.mock("../../controllers/announcementController.js", () => ({
  getWebAnnouncement: async () => null,
  getPopupAnnouncements: async () => [],
}));

const SECRET = "Route-Test-Secret-Value-42";

suite("Credential Vault routes", () => {
  let app;
  let admin;
  let pool;
  let dbName;
  let svc;
  let features;
  let currentUser = null;
  let currentSession = "sess-route-test-aaaaaaaaaaaaaaaa";
  const ids = {};

  function as(userKey, { sessionId } = {}) {
    currentUser = userKey ? ids.users[userKey] : null;
    currentSession = sessionId || `sess-route-test-${userKey}-aaaaaaaa`;
  }

  async function get(url) {
    return app.inject({ method: "GET", url });
  }

  async function postJson(url, body) {
    return app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
  }

  async function postForm(url, body) {
    return app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(body).toString() });
  }

  beforeAll(async () => {
    const mysql = (await import("mysql2/promise")).default;
    const bcrypt = (await import("bcrypt")).default;
    const url = new URL(TEST_URL);
    const conn = {
      host: url.hostname,
      port: Number(url.port) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      timezone: "Z",
    };
    admin = await mysql.createConnection({ ...conn, multipleStatements: true });
    dbName = `zander_cv_routes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${dbName}\``);
    await admin.query(`CREATE TABLE users (
      userId INT NOT NULL AUTO_INCREMENT PRIMARY KEY, uuid VARCHAR(36) NOT NULL UNIQUE, username VARCHAR(16) NOT NULL,
      password_hash VARCHAR(255) NULL, account_disabled TINYINT(1) NOT NULL DEFAULT 0, is_placeholder TINYINT(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(readFileSync(new URL("../../prisma/migrations/0077_credential_vault/migration.sql", import.meta.url), "utf8"));
    pool = mysql.createPool({ ...conn, database: dbName, connectionLimit: 10 });

    const store = await import("../../controllers/credentialVaultController.js");
    store.setVaultDatabase(pool);
    svc = await import("../../services/credentialVaultService.js");
    const cryptoLib = await import("../../lib/credentialVault/crypto.mjs");
    svc.configureVaultServiceForTests({
      keyProvider: new cryptoLib.EnvKeyProvider({ keks: `k1:${cryptoLib.generateKek()}`, activeKekId: "k1" }),
      notify: async () => {},
    });

    const mk = async (username, password) => {
      const [r] = await pool.query(`INSERT INTO users (uuid, username, password_hash) VALUES (?, ?, ?)`, [
        crypto.randomUUID(),
        username,
        password ? await bcrypt.hash(password, 4) : null,
      ]);
      return r.insertId;
    };
    ids.users = {
      admin: await mk("vaultadmin", "Admin-Password-1"),
      editor: await mk("editor", "Editor-Password-1"),
      reader: await mk("reader", "Reader-Password-1"),
      outsider: await mk("outsider", "Outsider-Password-1"),
      discord: await mk("discordonly", null),
    };
    const g = (userId, scope, capabilities, extra = {}) =>
      store.insertGrant({ scope, principalType: "user", userId, effect: "allow", capabilities, ...extra }, null);
    await g(ids.users.admin, "vault", ["manage_vault", "manage_collections", "view_audit", "approve_requests"]);
    await g(ids.users.editor, "collection", ["create", "edit", "reveal", "copy", "view_history", "delete", "manage_access"], { collectionId: 1 });
    await g(ids.users.reader, "collection", ["reveal"], { collectionId: 1 });

    const editor = await svc.loadActor(ids.users.editor, {});
    ids.credential = await svc.createCredential(editor, {
      meta: {
        type: "login", name: "Instagram <script>x</script>", collectionId: 1, url: "https://instagram.com/", username: "cfc",
        email: null, description: "desc", details: { customFields: [] }, tags: ["social"], ownerUserId: null, ownerUsername: null,
        isRequestable: true, expiresAt: null, rotateEveryDays: 90, nextRotationAt: new Date(Date.now() + 86400000),
      },
      secretChanges: { set: { password: SECRET, totpSecret: "TOTPSECRET123" }, clear: [] },
    });

    // Minimal app with the real view engine and the real route module.
    const fastify = (await import("fastify")).default;
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const config = require("../../lib/config/config.cjs");
    features = require("../../lib/config/features.cjs");
    features.credentialVault = true;
    const { getMenuGroups } = await import("../../admin/pageRegistry.js");

    app = fastify();
    await app.register((await import("@fastify/cookie")).default);
    await app.register((await import("@fastify/formbody")).default);
    await app.register((await import("@fastify/view")).default, {
      engine: { ejs: (await import("ejs")).default },
      root: path.join(__dirname, "../../views"),
      defaultContext: { buildInfo: {}, siteMenu: () => [] },
    });
    app.addHook("preHandler", async (req) => {
      req.session = currentUser
        ? {
            sessionId: currentSession,
            user: { userId: currentUser, username: "x", permissions: ["zander.web.credentials", "zander.web.dashboard"], authenticatedAt: Date.now() },
          }
        : { sessionId: currentSession };
      req.adminMenuGroups = getMenuGroups(req.session.user?.permissions || [], features);
    });
    const route = (await import("../../routes/dashboard/credentials.js")).default;
    route(app, config, features, {});
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await admin.end();
    }
  });

  const pages = [
    "/dashboard/credentials",
    "/dashboard/credentials?favourites=1",
    "/dashboard/credentials?q=insta&type=login&filter=rotation&sort=updated",
    "/dashboard/credentials/new",
    "/dashboard/credentials/new?type=login",
    "/dashboard/credentials/new?type=api",
    "/dashboard/credentials/new?type=dev_secret",
    "/dashboard/credentials/new?type=recovery",
    "/dashboard/credentials/new?type=secure_note",
    "/dashboard/credentials/security",
    "/dashboard/credentials/collections",
    "/dashboard/credentials/collections/1",
    "/dashboard/credentials/requests",
    "/dashboard/credentials/trash",
  ];

  it("renders every editor page without leaking a secret, with no-store headers", async () => {
    as("editor");
    const detailPages = [`/dashboard/credentials/${0}`].map(() => `/dashboard/credentials/${ids.credential}`);
    for (const url of [...pages, ...detailPages, `/dashboard/credentials/${ids.credential}/edit`, `/dashboard/credentials/${ids.credential}/history`, `/dashboard/credentials/${ids.credential}/access`]) {
      const res = await get(url);
      expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
      expect(res.body, url).not.toContain(SECRET);
      expect(res.body, url).not.toContain("TOTPSECRET123");
      expect(res.body, url).not.toContain("<script>x</script>");
      expect(res.headers["cache-control"], url).toContain("no-store");
    }
  });

  it("renders the administrator pages", async () => {
    as("admin");
    for (const url of [
      "/dashboard/credentials/admin",
      "/dashboard/credentials/groups",
      "/dashboard/credentials/health",
      "/dashboard/credentials/audit",
      "/dashboard/credentials/audit?event=secret_revealed&outcome=success&from=2020-01-01&to=2030-01-01",
      "/dashboard/credentials/admin/rotation",
      "/dashboard/credentials/admin/offboard",
      "/dashboard/credentials/admin/offboard?user=reader",
    ]) {
      const res = await get(url);
      expect(res.statusCode, `${url}: ${res.body.slice(0, 500)}`).toBe(200);
      expect(res.body).not.toContain(SECRET);
    }
  });

  it("admins without a reveal grant cannot open the credential, outsiders get 404", async () => {
    as("admin");
    expect((await get(`/dashboard/credentials/${ids.credential}`)).statusCode).toBe(404);
    as("outsider");
    expect((await get(`/dashboard/credentials/${ids.credential}`)).statusCode).toBe(404);
    expect((await get(`/dashboard/credentials/999999`)).statusCode).toBe(404);
    const list = await get("/dashboard/credentials");
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain("Instagram");
  });

  it("anonymous and non-staff requests to the API are refused", async () => {
    as(null);
    const res = await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "reveal", field: "password" });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(SECRET);
  });

  it("reveal and copy each need their own verification through the API", async () => {
    as("editor");
    const start = await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "reveal", field: "password" });
    expect(start.statusCode).toBe(200);
    const { challengeToken, method } = start.json();
    expect(method).toBe("account_password");
    expect(start.headers["cache-control"]).toContain("no-store");

    const bad = await postJson("/dashboard/credentials/api/challenges/verify", { challengeToken, password: "wrong" });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).not.toContain(SECRET);
    const replay = await postJson("/dashboard/credentials/api/challenges/verify", { challengeToken, password: "Editor-Password-1" });
    expect(replay.statusCode).toBe(401);

    const again = (await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "reveal", field: "password" })).json();
    const ok = await postJson("/dashboard/credentials/api/challenges/verify", { challengeToken: again.challengeToken, password: "Editor-Password-1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().value).toBe(SECRET);
    expect(ok.headers["cache-control"]).toContain("no-store");
    expect(ok.headers.pragma).toBe("no-cache");

    const copy = (await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "copy", field: "password" })).json();
    expect(copy.challengeToken).not.toBe(again.challengeToken);
    const copied = await postJson("/dashboard/credentials/api/challenges/verify", { challengeToken: copy.challengeToken, password: "Editor-Password-1" });
    expect(copied.json()).toMatchObject({ action: "copy", value: SECRET });
  });

  it("a challenge from one session cannot be completed from another", async () => {
    as("editor", { sessionId: "session-one-aaaaaaaaaaaaaaaa" });
    const { challengeToken } = (await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "reveal", field: "password" })).json();
    as("editor", { sessionId: "session-two-bbbbbbbbbbbbbbbb" });
    const res = await postJson("/dashboard/credentials/api/challenges/verify", { challengeToken, password: "Editor-Password-1" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(SECRET);
  });

  it("the reader cannot copy and cannot start a challenge for a field that does not exist", async () => {
    as("reader");
    expect((await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "copy", field: "password" })).statusCode).toBe(403);
    expect((await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "reveal", field: "apiKey" })).statusCode).toBe(400);
    expect((await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "export", field: "password" })).statusCode).toBe(400);
  });

  it("the edit form never contains stored values, and a blank save keeps them", async () => {
    as("editor");
    const form = await get(`/dashboard/credentials/${ids.credential}/edit`);
    expect(form.body).toContain("Leave blank to keep");
    const save = await postForm(`/dashboard/credentials/${ids.credential}`, {
      name: "Instagram",
      collectionId: "1",
      url: "https://instagram.com",
      username: "cfc",
      secret_password: "",
      secret_totpSecret: "",
    });
    expect(save.statusCode).toBe(302);
    const { challengeToken } = (await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "reveal", field: "password" })).json();
    const ok = await postJson("/dashboard/credentials/api/challenges/verify", { challengeToken, password: "Editor-Password-1" });
    expect(ok.json().value).toBe(SECRET);
  });

  it("issues an enrolment code once, and the security page asks Discord-only staff for it", async () => {
    as("admin");
    const res = await postForm("/dashboard/credentials/admin/enrolment-code", { username: "discordonly" });
    expect(res.statusCode).toBe(200);
    const code = res.body.match(/value="([A-Z2-9]{5}(?:-[A-Z2-9]{5}){3})"/);
    expect(code).not.toBeNull();
    expect(res.headers["cache-control"]).toContain("no-store");
    as("discord");
    const page = await get("/dashboard/credentials/security");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="enrolmentCode"');
    expect(page.body).not.toContain(code[1]);
    const enrol = await postForm("/dashboard/credentials/security/enrol", {
      enrolmentCode: code[1],
      password: "correct horse battery staple 9",
      confirm: "correct horse battery staple 9",
    });
    expect(enrol.statusCode).toBe(302);
    const after = await get("/dashboard/credentials/security");
    expect(after.body).toContain("vault password");
    expect(after.body).toContain('name="currentPassword"');
  });

  it("non-administrators cannot probe usernames through offboarding", async () => {
    as("editor");
    const res = await get("/dashboard/credentials/admin/offboard?user=nobody-here");
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 everywhere when the module is switched off", async () => {
    features.credentialVault = false;
    as("editor");
    const res = await postJson("/dashboard/credentials/api/challenges", { credentialId: ids.credential, action: "reveal", field: "password" });
    expect(res.statusCode).toBe(404);
    features.credentialVault = true;
  });
});
