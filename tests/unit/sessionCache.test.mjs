import { describe, it, expect } from "vitest";
import { SessionCache } from "../../lib/sessionCache.mjs";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("SessionCache", () => {
  it("serves a fresh copy within the TTL, then stops", () => {
    const c = clock();
    const cache = new SessionCache({ ttlMs: 1000, staleMs: 5000, now: c.now });
    cache.set("a", { user: { userId: 1 } });
    expect(cache.fresh("a")).toEqual({ user: { userId: 1 } });
    c.advance(1001);
    expect(cache.fresh("a")).toBeUndefined();
    expect(cache.stale("a")).toEqual({ user: { userId: 1 } });
    c.advance(5000);
    expect(cache.stale("a")).toBeUndefined();
  });

  it("never serves a session past its own expiry, even as a stale fallback", () => {
    const c = clock();
    const cache = new SessionCache({ ttlMs: 60_000, staleMs: 900_000, now: c.now });
    cache.set("a", { user: { userId: 1 } }, c.now() + 500);
    c.advance(600);
    expect(cache.fresh("a")).toBeUndefined();
    expect(cache.stale("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("hands out copies, so one request cannot change another's session", () => {
    const cache = new SessionCache();
    const original = { user: { userId: 1 } };
    cache.set("a", original);
    original.user.userId = 99;
    const first = cache.fresh("a");
    first.user.userId = 42;
    expect(cache.fresh("a")).toEqual({ user: { userId: 1 } });
  });

  it("forgets deleted sessions and evicts the oldest past the size limit", () => {
    const cache = new SessionCache({ maxEntries: 2 });
    cache.set("a", { n: 1 });
    cache.set("b", { n: 2 });
    cache.set("c", { n: 3 });
    expect(cache.fresh("a")).toBeUndefined();
    cache.delete("b");
    expect(cache.fresh("b")).toBeUndefined();
    expect(cache.fresh("c")).toEqual({ n: 3 });
  });

  it("extends a cached session's expiry on touch", () => {
    const c = clock();
    const cache = new SessionCache({ now: c.now });
    cache.set("a", { n: 1 }, c.now() + 100);
    cache.extend("a", c.now() + 10_000);
    c.advance(500);
    expect(cache.fresh("a")).toEqual({ n: 1 });
  });
});
