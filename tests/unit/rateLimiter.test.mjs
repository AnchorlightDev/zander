import { describe, it, expect, vi } from "vitest";
import { checkRateLimit } from "../../lib/rateLimiter.mjs";

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

// The limiter keys on IP + route, and its store is module-level, so every test
// uses a distinct IP to stay isolated from the others.
let ipCounter = 0;
const nextIp = () => `10.0.0.${++ipCounter}`;

function makeReq({ ip = nextIp(), method = "POST", url = "/login", routeUrl, forwardedFor } = {}) {
  const req = {
    ip,
    method,
    url,
    headers: {},
    routeOptions: routeUrl === undefined ? undefined : { url: routeUrl },
  };
  if (forwardedFor) req.headers["x-forwarded-for"] = forwardedFor;
  return req;
}

describe("checkRateLimit", () => {
  it("allows requests up to the limit and blocks the next one", () => {
    const req = makeReq();
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(req, makeRes(), { windowMs: 60_000, max: 3 })).toBe(true);
    }
    const res = makeRes();
    expect(checkRateLimit(req, res, { windowMs: 60_000, max: 3 })).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.payload).toMatchObject({ success: false });
  });

  it("tracks each IP independently", () => {
    const a = makeReq({ url: "/shared-route" });
    const b = makeReq({ url: "/shared-route" });
    expect(checkRateLimit(a, makeRes(), { max: 1 })).toBe(true);
    expect(checkRateLimit(a, makeRes(), { max: 1 })).toBe(false);
    // b has its own bucket and is unaffected by a exhausting theirs
    expect(checkRateLimit(b, makeRes(), { max: 1 })).toBe(true);
  });

  it("tracks each route independently for the same IP", () => {
    const ip = nextIp();
    const login = makeReq({ ip, url: "/login" });
    const register = makeReq({ ip, url: "/register" });
    expect(checkRateLimit(login, makeRes(), { max: 1 })).toBe(true);
    expect(checkRateLimit(login, makeRes(), { max: 1 })).toBe(false);
    expect(checkRateLimit(register, makeRes(), { max: 1 })).toBe(true);
  });

  it("prefers routeOptions.url so parameterised routes share one bucket", () => {
    // Fastify 5 replaced req.routerPath with req.routeOptions.url. If this
    // regressed, /profile/alice and /profile/bob would get separate buckets
    // and the limit could be bypassed by varying the path parameter.
    const ip = nextIp();
    const opts = { windowMs: 60_000, max: 2 };
    const alice = makeReq({ ip, method: "GET", url: "/profile/alice/edit", routeUrl: "/profile/:username/edit" });
    const bob = makeReq({ ip, method: "GET", url: "/profile/bob/edit", routeUrl: "/profile/:username/edit" });
    const carol = makeReq({ ip, method: "GET", url: "/profile/carol/edit", routeUrl: "/profile/:username/edit" });

    expect(checkRateLimit(alice, makeRes(), opts)).toBe(true);
    expect(checkRateLimit(bob, makeRes(), opts)).toBe(true);
    expect(checkRateLimit(carol, makeRes(), opts)).toBe(false);
  });

  it("falls back to req.url when routeOptions is absent", () => {
    const req = makeReq({ method: "GET", url: "/no-route-options" });
    expect(checkRateLimit(req, makeRes(), { max: 1 })).toBe(true);
    expect(checkRateLimit(req, makeRes(), { max: 1 })).toBe(false);
  });

  it("uses the leftmost x-forwarded-for entry as the client identity", () => {
    const shared = { method: "POST", url: "/xff-route" };
    const first = makeReq({ ...shared, ip: "10.9.9.9", forwardedFor: "203.0.113.5, 70.41.3.18" });
    const same = makeReq({ ...shared, ip: "10.9.9.9", forwardedFor: "203.0.113.5, 198.51.100.7" });
    const other = makeReq({ ...shared, ip: "10.9.9.9", forwardedFor: "203.0.113.99" });

    expect(checkRateLimit(first, makeRes(), { max: 1 })).toBe(true);
    // Same client IP behind a different downstream proxy — still one bucket.
    expect(checkRateLimit(same, makeRes(), { max: 1 })).toBe(false);
    // A genuinely different client is unaffected.
    expect(checkRateLimit(other, makeRes(), { max: 1 })).toBe(true);
  });

  it("starts a fresh window after the previous one expires", () => {
    vi.useFakeTimers();
    try {
      const req = makeReq({ url: "/expiring-window" });
      expect(checkRateLimit(req, makeRes(), { windowMs: 1_000, max: 1 })).toBe(true);
      expect(checkRateLimit(req, makeRes(), { windowMs: 1_000, max: 1 })).toBe(false);
      vi.advanceTimersByTime(1_500);
      expect(checkRateLimit(req, makeRes(), { windowMs: 1_000, max: 1 })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
