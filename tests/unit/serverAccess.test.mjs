import { describe, it, expect, vi } from "vitest";

// Keep the DB layer out of these pure tests (the action registry pulls it in).
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  luckpermsDb: { query: vi.fn() },
  prisma: {},
  withDeadlockRetry: async (fn) => fn(),
}));

import {
  accessNode,
  diffRanks,
  parseVelocityName,
  playerGrantCommands,
  playerRevokeCommands,
  rankCommands,
  summariseRows,
  tempDuration,
} from "../../lib/servers/serverAccess.mjs";
const { getActionModule } = await import("../../lib/scheduler/actions/index.mjs");

describe("server access node", () => {
  it("is the node Velocity checks, lower-cased", () => {
    expect(accessNode("Dev")).toBe("serverpermissions.server.dev");
  });

  it("rejects anything that could change a command's shape", () => {
    for (const bad of ["", "dev test", "dev\nlp group default permission set *", "dev;x", "a".repeat(65)]) {
      expect(() => accessNode(bad)).toThrow();
    }
  });

  it("parses the editor field: blank clears, invalid is rejected", () => {
    expect(parseVelocityName("  ")).toBeNull();
    expect(parseVelocityName(" events ")).toBe("events");
    expect(parseVelocityName("events hub")).toBeUndefined();
  });
});

describe("rank access", () => {
  const known = ["default", "supporter", "donator", "developer"];

  it("queues only the difference, and only for ranks that exist", () => {
    expect(diffRanks(["default", "developer"], ["Default", "supporter", "made-up"], known)).toEqual({ grant: ["supporter"], revoke: ["developer"] });
    expect(diffRanks(["default"], ["default"], known)).toEqual({ grant: [], revoke: [] });
  });

  it("builds idempotent set/unset commands", () => {
    expect(rankCommands("dev", { grant: ["Supporter"], revoke: ["default"] })).toEqual([
      "lp group supporter permission set serverpermissions.server.dev true",
      "lp group default permission unset serverpermissions.server.dev",
    ]);
    expect(() => rankCommands("dev", { grant: ["bad rank"] })).toThrow();
  });
});

describe("player access", () => {
  const now = new Date("2026-11-14T00:00:00Z");

  it("grants permanently, clearing any temporary grant first", () => {
    expect(playerGrantCommands("dev", "Tester_1", { now })).toEqual([
      "lp user Tester_1 permission unsettemp serverpermissions.server.dev",
      "lp user Tester_1 permission set serverpermissions.server.dev true",
    ]);
  });

  it("grants until a time with a LuckPerms temporary permission", () => {
    expect(playerGrantCommands("dev", "Tester_1", { expiresAt: new Date("2026-11-15T00:00:00Z"), now })).toEqual([
      "lp user Tester_1 permission unset serverpermissions.server.dev",
      "lp user Tester_1 permission settemp serverpermissions.server.dev true 86400s replace",
    ]);
  });

  it("refuses odd usernames and unusable expiries", () => {
    expect(() => playerGrantCommands("dev", "two words", { now })).toThrow();
    expect(() => playerGrantCommands("dev", "a".repeat(17), { now })).toThrow();
    expect(() => tempDuration(new Date("2026-11-13T23:00:00Z"), now)).toThrow(/minute/);
    expect(() => tempDuration(new Date("2028-01-01T00:00:00Z"), now)).toThrow(/year/);
    expect(() => tempDuration("invalid", now)).toThrow();
    expect(tempDuration("", now)).toBeNull();
  });

  it("revokes both kinds", () => {
    expect(playerRevokeCommands("dev", "Tester_1")).toEqual([
      "lp user Tester_1 permission unset serverpermissions.server.dev",
      "lp user Tester_1 permission unsettemp serverpermissions.server.dev",
    ]);
  });
});

describe("reading LuckPerms rows", () => {
  it("manages only global grants, lists the rest, skips expired ones", () => {
    const rows = [
      { name: "supporter", value: 1, server: "global", world: "global", expiry: 0 },
      { name: "builder", value: 1, server: "survival", world: "global", expiry: 0 },
      { name: "banned", value: 0, server: "global", world: "global", expiry: 0 },
      { name: "old", value: 1, server: "global", world: "global", expiry: 100 },
      { name: "tester", value: 1, server: "global", world: "global", expiry: 5000 },
    ];
    const r = summariseRows(rows, { nowSeconds: 1000 });
    expect(r.managed.map((m) => m.id)).toEqual(["supporter", "tester"]);
    expect(r.managed[1].expiresAt.getTime()).toBe(5000 * 1000);
    expect(r.other.map((o) => [o.id, o.denied])).toEqual([["builder", false], ["banned", true]]);
  });
});

describe("server_access scheduler action", () => {
  const mod = getActionModule("server_access");

  it("validates server, mode and ranks", () => {
    expect(mod.validate({ server: "dev", mode: "grant", ranks: ["supporter"] })).toEqual([]);
    expect(mod.validate({ server: "dev", mode: "grant", ranks: "supporter, donator" })).toEqual([]);
    expect(mod.validate({ server: "dev test", mode: "open", ranks: [] }).length).toBe(3);
    expect(mod.validate({ server: "dev", mode: "revoke", ranks: ["bad rank"] }).length).toBe(1);
  });

  it("describes what it will do", () => {
    expect(mod.describe({ server: "dev", mode: "grant", ranks: ["supporter"] })).toBe("Let supporter join server dev");
    expect(mod.describe({ server: "dev", mode: "revoke", ranks: ["supporter", "donator"] })).toBe("Remove supporter, donator from server dev");
    expect(mod.preview({ server: "dev", mode: "revoke", ranks: ["supporter"] }).sideEffects[0]).toContain("unset serverpermissions.server.dev");
  });
});
