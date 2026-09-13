import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import verifyToken from "../../api/routes/verifyToken.js";

const MACHINE_KEY = "s3cret-machine-key-for-the-minecraft-plugins";

/** Minimal Fastify-reply stand-in that records the status/payload it was sent. */
function makeRes() {
  const res = {
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
  return res;
}

function makeReq({ method = "GET", url = "/api/events/get", token, user } = {}) {
  return {
    method,
    url,
    headers: token === undefined ? {} : { "x-access-token": token },
    session: user ? { user } : {},
  };
}

/** Runs the hook and reports whether it called done() (i.e. allowed the request). */
function run(req) {
  const res = makeRes();
  const done = vi.fn();
  verifyToken(req, res, done);
  return { allowed: done.mock.calls.length === 1, status: res.statusCode, res };
}

describe("verifyToken", () => {
  let previousKey;

  beforeEach(() => {
    previousKey = process.env.apiKey;
    process.env.apiKey = MACHINE_KEY;
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.apiKey;
    else process.env.apiKey = previousKey;
  });

  describe("machine token", () => {
    it("allows a request carrying the exact API key", () => {
      expect(run(makeReq({ token: MACHINE_KEY })).allowed).toBe(true);
    });

    it("rejects an incorrect token with 401", () => {
      const out = run(makeReq({ token: "not-the-key" }));
      expect(out.allowed).toBe(false);
      expect(out.status).toBe(401);
    });

    it("rejects a token of a different length without throwing", () => {
      // timingSafeEqual throws on length mismatch unless digests are compared.
      expect(() => run(makeReq({ token: "short" }))).not.toThrow();
      expect(run(makeReq({ token: "short" })).allowed).toBe(false);
      expect(run(makeReq({ token: MACHINE_KEY + "extra" })).allowed).toBe(false);
    });

    it("fails closed when the server has no apiKey configured", () => {
      delete process.env.apiKey;
      expect(run(makeReq({ token: "anything" })).allowed).toBe(false);
      expect(run(makeReq({ token: "undefined" })).allowed).toBe(false);
    });

    it("does not fall through to session auth when a bad token is supplied", () => {
      // A wrong token must 401 outright rather than being retried as a session.
      const out = run(
        makeReq({
          token: "wrong",
          url: "/api/events/pending-review",
          user: { permissions: ["*"] },
        })
      );
      expect(out.allowed).toBe(false);
      expect(out.status).toBe(401);
    });
  });

  describe("session fallback", () => {
    it("allows an allowlisted route when the user holds the node", () => {
      const out = run(
        makeReq({
          url: "/api/events/pending-review",
          user: { permissions: ["zander.web.events.review"] },
        })
      );
      expect(out.allowed).toBe(true);
    });

    it("honours wildcard permissions", () => {
      expect(
        run(makeReq({ url: "/api/events/pending-review", user: { permissions: ["*"] } })).allowed
      ).toBe(true);
      expect(
        run(makeReq({ url: "/api/events/pending-review", user: { permissions: ["zander.web.*"] } }))
          .allowed
      ).toBe(true);
    });

    it("returns 403 when the user lacks the required node", () => {
      const out = run(
        makeReq({
          url: "/api/events/pending-review",
          user: { permissions: ["zander.web.forums"] },
        })
      );
      expect(out.allowed).toBe(false);
      expect(out.status).toBe(403);
    });

    it("does not let an edit-only user reach a review-only endpoint", () => {
      const editor = { permissions: ["zander.web.events.edit"] };
      expect(run(makeReq({ method: "POST", url: "/api/events/approve", user: editor })).allowed).toBe(
        false
      );
      expect(run(makeReq({ method: "POST", url: "/api/events/reject", user: editor })).allowed).toBe(
        false
      );
      // ...but may still perform edit-scoped actions
      expect(run(makeReq({ method: "POST", url: "/api/events/publish", user: editor })).allowed).toBe(
        true
      );
    });

    it("ignores the query string when matching the route", () => {
      const out = run(
        makeReq({
          url: "/api/events/users/search?q=steve",
          user: { permissions: ["zander.web.events.edit"] },
        })
      );
      expect(out.allowed).toBe(true);
    });

    it("matches on method as well as path", () => {
      // /api/events/approve is allowlisted for POST only.
      const reviewer = { permissions: ["zander.web.events.review"] };
      expect(run(makeReq({ method: "GET", url: "/api/events/approve", user: reviewer })).allowed).toBe(
        false
      );
    });

    it("rejects an anonymous request to an allowlisted route", () => {
      const out = run(makeReq({ url: "/api/events/pending-review" }));
      expect(out.allowed).toBe(false);
      expect(out.status).toBe(401);
    });
  });

  describe("fails closed for non-allowlisted routes", () => {
    // The regression this whole change exists to prevent: a logged-in user
    // must not reach sensitive APIs just by holding a session.
    const sensitive = [
      ["GET", "/api/finance/payouts"],
      ["POST", "/api/vault/withdraw"],
      ["GET", "/api/adminUsers/list"],
      ["POST", "/api/punishments/create"],
      ["GET", "/api/config/get"],
      ["POST", "/api/bridge/send"],
    ];

    for (const [method, url] of sensitive) {
      it(`denies ${method} ${url} to a session holding zander.web.*`, () => {
        const out = run(makeReq({ method, url, user: { permissions: ["zander.web.*"] } }));
        expect(out.allowed).toBe(false);
        expect(out.status).toBe(401);
      });
    }

    it("denies even a session holding the global * wildcard", () => {
      // Browsers never get blanket API access; the machine token is required.
      const out = run(
        makeReq({ method: "GET", url: "/api/finance/payouts", user: { permissions: ["*"] } })
      );
      expect(out.allowed).toBe(false);
    });
  });
});
