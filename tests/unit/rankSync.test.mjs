import { describe, it, expect, vi, beforeEach } from "vitest";

const queries = [];
let nextError = null;

vi.mock("../../controllers/databaseController.js", () => ({
  default: {},
  luckpermsDb: {
    query: (sql, params, callback) => {
      queries.push({ sql, params });
      const error = nextError;
      nextError = null;
      callback(error);
    },
  },
}));

const {
  syncUserRanks,
  syncAllRanks,
  isSessionPermissionsInvalidated,
  encodeLuckPermsMessage,
  normaliseUuid,
} = await import("../../controllers/rankSyncController.js");

const HEX = "0f8fad5bd9cb469fa165708167b0e3cc";
const DASHED = "0f8fad5b-d9cb-469f-a165-708167b0e3cc";

describe("rankSyncController", () => {
  beforeEach(() => {
    queries.length = 0;
    nextError = null;
  });

  it("encodes messages the way LuckPerms' messaging service does", () => {
    const message = JSON.parse(encodeLuckPermsMessage("userupdate", { userUuid: DASHED }));
    expect(message.type).toBe("userupdate");
    expect(message.content).toEqual({ userUuid: DASHED });
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/);

    const update = JSON.parse(encodeLuckPermsMessage("update"));
    expect(update).not.toHaveProperty("content");
  });

  it("normalises dashed and undashed UUIDs and rejects junk", () => {
    expect(normaliseUuid(DASHED.toUpperCase())).toBe(HEX);
    expect(normaliseUuid(HEX)).toBe(HEX);
    expect(normaliseUuid("not-a-uuid")).toBeNull();
    expect(normaliseUuid(null)).toBeNull();
  });

  it("publishes a userupdate with a dashed UUID to luckperms_messenger", async () => {
    await expect(syncUserRanks(HEX)).resolves.toBe(true);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("INSERT INTO luckperms_messenger (time, msg) VALUES (NOW(), ?)");
    expect(JSON.parse(queries[0].params[0]).content.userUuid).toBe(DASHED);
  });

  it("publishes a full update when groups change", async () => {
    await expect(syncAllRanks()).resolves.toBe(true);
    expect(JSON.parse(queries[0].params[0]).type).toBe("update");
  });

  it("never throws when LuckPerms can't be notified", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    nextError = Object.assign(new Error("missing"), { code: "ER_NO_SUCH_TABLE" });
    await expect(syncUserRanks(HEX)).resolves.toBe(false);
  });

  it("invalidates only sessions loaded before the change", async () => {
    const loadedBefore = Date.now() - 1000;

    await syncUserRanks(DASHED);

    expect(isSessionPermissionsInvalidated(HEX, loadedBefore)).toBe(true);
    expect(isSessionPermissionsInvalidated(HEX, Date.now() + 1000)).toBe(false);
  });

  it("invalidates every session after a group change", async () => {
    const loadedBefore = Date.now() - 1000;
    await syncAllRanks();
    expect(isSessionPermissionsInvalidated("2222222222222222222222222222bbbb", loadedBefore)).toBe(true);
    expect(isSessionPermissionsInvalidated(null, loadedBefore)).toBe(true);
    expect(isSessionPermissionsInvalidated(null, Date.now() + 1000)).toBe(false);
  });
});
