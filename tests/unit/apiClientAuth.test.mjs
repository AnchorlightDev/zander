import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKey, hashKey, verifyKeyHash, resolveScope } from "../../lib/apiKeys.js";

// verifyToken pulls the controller in for the client lookup; the controller
// opens a mysql2 pool at import time, so it is stubbed here.
const mockGetClientByPrefixCached = vi.fn();
const mockTouchLastUsed = vi.fn();

vi.mock("../../controllers/apiClientController.js", () => ({
  getClientByPrefixCached: (...a) => mockGetClientByPrefixCached(...a),
  touchLastUsed: (...a) => mockTouchLastUsed(...a),
}));

vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => (specifier) => {
      if (specifier.includes("lang.json")) {
        return {
          api: {
            noToken: "There was no token included in this request.",
            invalidToken: "The token that was provided is not valid or incorrect.",
            databaseError: "A database error has occured trying to process this request.",
          },
        };
      }
      throw new Error(`unexpected require: ${specifier}`);
    },
  };
});

const { default: verifyToken } = await import("../../api/routes/verifyToken.js");

// The app-wide shared secret that used to be accepted via process.env.apiKey.
// The cutover is complete; it is now just another invalid token.
const RETIRED_SHARED_KEY = "legacy-shared-key-value";

function makeRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.payload = body;
      return this;
    },
  };
}

function makeReq({ method = "GET", url = "/api/server/get", token, user } = {}) {
  return {
    method,
    url,
    ip: "203.0.113.10",
    headers: token === undefined ? {} : { "x-access-token": token },
    session: user ? { user } : {},
  };
}

/** Runs the hook; `allowed` is true when it returned without sending a response. */
async function run(req) {
  const res = makeRes();
  await verifyToken(req, res);
  return { allowed: res.statusCode === null, status: res.statusCode, res, req };
}

/** A stored client row as the controller would return it. */
function client({ scopes = ["server"], isRevoked = false, keyHash, clientId = 1 } = {}) {
  return { clientId, name: "test-client", scopes, isRevoked, keyHash };
}

describe("generateKey", () => {
  it("produces a verifiable hash of the full key", () => {
    const { fullKey, keyHash } = generateKey();
    expect(hashKey(fullKey)).toBe(keyHash);
    expect(verifyKeyHash(fullKey, keyHash)).toBe(true);
  });

  it("produces distinct keys", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateKey().fullKey));
    expect(keys.size).toBe(500);
  });

  it("uses the documented shape", () => {
    const { fullKey, keyPrefix } = generateKey();
    expect(fullKey).toMatch(/^zdr_[a-z0-9]{8}_[A-Za-z0-9]{40}$/);
    expect(fullKey.startsWith(`zdr_${keyPrefix}_`)).toBe(true);
  });

  it("does not verify against another key's hash", () => {
    const a = generateKey();
    const b = generateKey();
    expect(verifyKeyHash(a.fullKey, b.keyHash)).toBe(false);
  });
});

describe("resolveScope", () => {
  it("maps each API surface to its scope", () => {
    expect(resolveScope("/api/server/get")).toBe("server");
    expect(resolveScope("/api/events/publish")).toBe("events");
    expect(resolveScope("/admin/users/stats")).toBe("adminUsers");
    expect(resolveScope("/policy")).toBe("config");
  });

  it("prefers the longer prefix so discord-punishments is not read as discord", () => {
    expect(resolveScope("/api/discord-punishments/get")).toBe("punishments");
    expect(resolveScope("/api/discord/chat")).toBe("discord");
  });

  it("ignores the query string", () => {
    expect(resolveScope("/api/user/get?username=steve")).toBe("user");
  });

  it("does not map /api/config, which is served unauthenticated elsewhere", () => {
    // app.js registers configApiRoute a second time under /api/config with no
    // token check. Mapping it here would imply a gate that does not exist.
    expect(resolveScope("/api/config/policy")).toBeNull();
    expect(resolveScope("/api/config/social")).toBeNull();
    // The token-protected copies are gated.
    expect(resolveScope("/social")).toBe("config");
  });

  it("returns null for unmapped paths so they fail closed", () => {
    expect(resolveScope("/api/heartbeat")).toBeNull();
    expect(resolveScope("/nope")).toBeNull();
    expect(resolveScope(undefined)).toBeNull();
  });
});

describe("verifyToken — per-client keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid key holding the required scope", async () => {
    const key = generateKey();
    mockGetClientByPrefixCached.mockResolvedValue(
      client({ scopes: ["server"], keyHash: key.keyHash })
    );

    const out = await run(makeReq({ token: key.fullKey, url: "/api/server/get" }));
    expect(out.allowed).toBe(true);
    expect(out.req.apiClient).toMatchObject({ clientId: 1, name: "test-client" });
  });

  it("records last use without blocking the auth path", async () => {
    const key = generateKey();
    mockGetClientByPrefixCached.mockResolvedValue(
      client({ scopes: ["server"], keyHash: key.keyHash })
    );

    await run(makeReq({ token: key.fullKey }));
    expect(mockTouchLastUsed).toHaveBeenCalledWith(1, "203.0.113.10");
  });

  it("rejects a valid key lacking the required scope with 403", async () => {
    const key = generateKey();
    mockGetClientByPrefixCached.mockResolvedValue(
      client({ scopes: ["vault"], keyHash: key.keyHash })
    );

    const out = await run(makeReq({ token: key.fullKey, url: "/api/server/get" }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(403);
    expect(out.res.payload.success).toBe(false);
  });

  it("rejects a revoked key with 401", async () => {
    const key = generateKey();
    mockGetClientByPrefixCached.mockResolvedValue(
      client({ scopes: ["server"], keyHash: key.keyHash, isRevoked: true })
    );

    const out = await run(makeReq({ token: key.fullKey }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(401);
  });

  it("rejects an unknown prefix with 401", async () => {
    mockGetClientByPrefixCached.mockResolvedValue(null);

    const out = await run(makeReq({ token: generateKey().fullKey }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(401);
  });

  it("rejects a correct prefix presented with the wrong secret", async () => {
    const real = generateKey();
    // Same prefix, different secret — the stored hash must not match.
    const forged = `zdr_${real.keyPrefix}_${"a".repeat(40)}`;
    mockGetClientByPrefixCached.mockResolvedValue(
      client({ scopes: ["server"], keyHash: real.keyHash })
    );

    const out = await run(makeReq({ token: forged }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(401);
  });

  it("rejects a missing header with 401", async () => {
    const out = await run(makeReq({}));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(401);
  });

  it("fails closed on a path with no scope mapping", async () => {
    const key = generateKey();
    mockGetClientByPrefixCached.mockResolvedValue(
      client({ scopes: ["server"], keyHash: key.keyHash })
    );

    const out = await run(makeReq({ token: key.fullKey, url: "/api/not-mapped/thing" }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(403);
  });

  it("returns 503 rather than allowing the request when the lookup fails", async () => {
    mockGetClientByPrefixCached.mockRejectedValue(new Error("db down"));

    const out = await run(makeReq({ token: generateKey().fullKey }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(503);
  });

  it("never returns 200 on a failure, unlike the old implementation", async () => {
    mockGetClientByPrefixCached.mockResolvedValue(null);
    for (const token of [undefined, "garbage", generateKey().fullKey]) {
      const out = await run(makeReq({ token }));
      expect(out.status).not.toBe(200);
      expect([401, 403, 503]).toContain(out.status);
    }
  });
});

describe("verifyToken — retired shared key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set even though nothing reads it: proves the cutover removed the read,
    // not merely that the variable happens to be unset in CI.
    process.env.apiKey = RETIRED_SHARED_KEY;
  });

  afterEach(() => {
    delete process.env.apiKey;
  });

  it("is rejected with 401 even while apiKey is still present in the environment", async () => {
    const out = await run(makeReq({ token: RETIRED_SHARED_KEY }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(401);
    expect(out.req.apiClient).toBeUndefined();
  });

  it("never consults the database for a non-`zdr_` token", async () => {
    await run(makeReq({ token: RETIRED_SHARED_KEY }));
    expect(mockGetClientByPrefixCached).not.toHaveBeenCalled();
  });
});

describe("verifyToken — dashboard session fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows an allowlisted route when the user holds the node", async () => {
    const out = await run(
      makeReq({
        url: "/api/events/pending-review",
        user: { permissions: ["zander.web.events.review"] },
      })
    );
    expect(out.allowed).toBe(true);
  });

  it("returns 403 when the session lacks the node", async () => {
    const out = await run(
      makeReq({
        url: "/api/events/pending-review",
        user: { permissions: ["zander.web.forums"] },
      })
    );
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(403);
  });

  it("honours wildcard permissions", async () => {
    for (const permissions of [["*"], ["zander.web.*"]]) {
      const out = await run(
        makeReq({ url: "/api/events/pending-review", user: { permissions } })
      );
      expect(out.allowed).toBe(true);
    }
  });

  it("does not let an edit-only user reach a review-only endpoint", async () => {
    const editor = { permissions: ["zander.web.events.edit"] };

    for (const url of ["/api/events/approve", "/api/events/reject"]) {
      const out = await run(makeReq({ method: "POST", url, user: editor }));
      expect(out.allowed).toBe(false);
      expect(out.status).toBe(403);
    }

    // ...but may still perform edit-scoped actions
    const ok = await run(
      makeReq({ method: "POST", url: "/api/events/publish", user: editor })
    );
    expect(ok.allowed).toBe(true);
  });

  it("ignores the query string when matching the route", async () => {
    const out = await run(
      makeReq({
        url: "/api/events/users/search?q=steve",
        user: { permissions: ["zander.web.events.edit"] },
      })
    );
    expect(out.allowed).toBe(true);
  });

  it("matches on method as well as path", async () => {
    // /api/events/approve is allowlisted for POST only.
    const out = await run(
      makeReq({
        method: "GET",
        url: "/api/events/approve",
        user: { permissions: ["zander.web.events.review"] },
      })
    );
    expect(out.allowed).toBe(false);
  });

  it("rejects an anonymous request to an allowlisted route", async () => {
    const out = await run(makeReq({ url: "/api/events/pending-review" }));
    expect(out.allowed).toBe(false);
    expect(out.status).toBe(401);
  });

  it("does not let a session reach a non-allowlisted API surface", async () => {
    // The regression the session allowlist exists to prevent: holding a
    // session must not grant blanket API access.
    for (const url of ["/api/finance/dashboard", "/admin/users/stats", "/api/vault/get"]) {
      const out = await run(makeReq({ url, user: { permissions: ["*"] } }));
      expect(out.allowed).toBe(false);
      expect(out.status).toBe(401);
    }
  });
});
