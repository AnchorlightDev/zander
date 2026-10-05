import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findUnique = vi.fn();
const executeRaw = vi.fn();
const deleteMany = vi.fn(async () => ({ count: 1 }));

vi.mock("../../controllers/databaseController.js", () => ({
  prisma: {
    session: { findUnique: (...a) => findUnique(...a), deleteMany: (...a) => deleteMany(...a), updateMany: vi.fn(async () => ({})) },
    $executeRaw: (...a) => executeRaw(...a),
  },
}));

const { FastifyPrismaSessionStore } = await import("../../lib/fastifyPrismaSessionStore.js");
const { SessionCache } = await import("../../lib/sessionCache.mjs");

const inAWeek = () => new Date(Date.now() + 7 * 86400_000);
const row = (data) => ({ sid: "s1", data: JSON.stringify(data), expiresAt: inAWeek() });
const get = (store, sid) => new Promise((resolve, reject) => store.get(sid, (err, data) => (err ? reject(err) : resolve(data))));
const set = (store, sid, data) => new Promise((resolve, reject) => store.set(sid, data, (err) => (err ? reject(err) : resolve())));
const destroy = (store, sid) => new Promise((resolve, reject) => store.destroy(sid, (err) => (err ? reject(err) : resolve())));

let store;
let cache;

beforeEach(() => {
  findUnique.mockReset();
  executeRaw.mockReset().mockResolvedValue(1);
  cache = new SessionCache();
  store = new FastifyPrismaSessionStore({ cache });
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

describe("session store with in-memory cache", () => {
  it("answers a repeat read from memory without the database", async () => {
    findUnique.mockResolvedValue(row({ user: { userId: 1 } }));
    expect(await get(store, "s1")).toEqual({ user: { userId: 1 } });
    expect(await get(store, "s1")).toEqual({ user: { userId: 1 } });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("keeps the person signed in when the database times out", async () => {
    findUnique.mockResolvedValueOnce(row({ user: { userId: 1 } }));
    await get(store, "s1");

    // Past the fresh window, and the database now hangs.
    cache.ttlMs = -1; // always past the fresh window, whatever the clock resolution
    findUnique.mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers();
    const pending = get(store, "s1");
    await vi.advanceTimersByTimeAsync(3100);
    expect(await pending).toEqual({ user: { userId: 1 } });
  });

  it("still treats an unknown session as logged out when the database times out", async () => {
    findUnique.mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers();
    const pending = get(store, "never-seen");
    await vi.advanceTimersByTimeAsync(3100);
    expect(await pending).toBeNull();
  });

  it("sees its own writes straight away, even before the database write lands", async () => {
    executeRaw.mockReturnValueOnce(new Promise(() => {}));
    store.set("s2", { user: { userId: 2 } }, () => {});
    expect(await get(store, "s2")).toEqual({ user: { userId: 2 } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("forgets a destroyed session at once (logout)", async () => {
    await set(store, "s3", { user: { userId: 3 } });
    await destroy(store, "s3");
    findUnique.mockResolvedValue(null);
    expect(await get(store, "s3")).toBeNull();
  });

  it("drops a session the database says has gone", async () => {
    await set(store, "s4", { user: { userId: 4 } });
    cache.ttlMs = -1; // always past the fresh window, whatever the clock resolution
    findUnique.mockResolvedValue(null);
    expect(await get(store, "s4")).toBeNull();
    expect(cache.stale("s4")).toBeUndefined();
  });
});
