import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";

const UUID = "11111111-2222-3333-4444-555555555555";

let settingsLoaded = true;
let grantsTable = [];
let lpHeld = new Set();
const executed = [];

// mysql2-style callback pools.
const db = {
  query: vi.fn((sql, params, cb) => {
    executed.push({ sql, params });
    if (/FROM boosterRewardGrants/.test(sql)) return cb(null, grantsTable);
    if (/FROM users/.test(sql)) return cb(null, [{ userId: 1, uuid: UUID, discordId: "100" }]);
    return cb(null, { affectedRows: 1 });
  }),
};
const luckpermsDb = {
  query: vi.fn((sql, params, cb) => cb(null, lpHeld.has(params[1]) ? [{ 1: 1 }] : [])),
};

vi.mock("../../controllers/databaseController.js", () => ({ default: db, luckpermsDb }));
vi.mock("../../controllers/discordController.js", () => ({ client: { isReady: () => true } }));
vi.mock("../../controllers/configSettingsController.js", () => ({ isSettingsLoaded: () => settingsLoaded }));

const config = createRequire(import.meta.url)("../../lib/config/config.cjs");
const { syncBoosterRewards } = await import("../../controllers/boosterRewardController.js");

const commands = () =>
  executed.filter((q) => /INSERT INTO executorTasks/.test(q.sql)).map((q) => q.params[0]);

beforeEach(() => {
  settingsLoaded = true;
  grantsTable = [];
  lpHeld = new Set();
  executed.length = 0;
  config.discord.boosterRewards = { enabled: true, rankGroups: ["booster"] };
});

describe("syncBoosterRewards", () => {
  it("queues the grant and records it", async () => {
    const result = await syncBoosterRewards({ boosterDiscordIds: new Set(["100"]) });
    expect(result).toEqual({ granted: 1, revoked: 0 });
    expect(commands()).toEqual([`lp user ${UUID} parent add booster`]);
    expect(executed.some((q) => /INSERT IGNORE INTO boosterRewardGrants/.test(q.sql))).toBe(true);
  });

  it("does not grant or record a rank the player already holds", async () => {
    lpHeld.add("group.booster");
    const result = await syncBoosterRewards({ boosterDiscordIds: new Set(["100"]) });
    expect(result.granted).toBe(0);
    expect(commands()).toEqual([]);
  });

  it("revokes and forgets a grant once the boost has ended", async () => {
    grantsTable = [{ userId: 1, discordId: "100", uuid: UUID, rankGroup: "booster" }];
    const result = await syncBoosterRewards({ boosterDiscordIds: new Set() });
    expect(result).toEqual({ granted: 0, revoked: 1 });
    expect(commands()).toEqual([`lp user ${UUID} parent remove booster`]);
    expect(executed.some((q) => /DELETE FROM boosterRewardGrants/.test(q.sql))).toBe(true);
  });

  it("does nothing at all until settings have loaded from the database", async () => {
    settingsLoaded = false;
    grantsTable = [{ userId: 1, discordId: "100", uuid: UUID, rankGroup: "booster" }];
    const result = await syncBoosterRewards({ boosterDiscordIds: new Set() });
    expect(result.skipped).toBe("settings-not-loaded");
    expect(executed).toEqual([]);
  });
});
