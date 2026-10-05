import { describe, it, expect } from "vitest";
import { buildRankCommand, normaliseRankGroups, planBoosterRewards } from "../../lib/discord/boosterRewards.mjs";
import { findField, parseFieldValue } from "../../lib/config/settingsRegistry.mjs";

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "66666666-7777-8888-9999-000000000000";
const linked = new Map([
  ["100", { userId: 1, uuid: UUID_A }],
  ["200", { userId: 2, uuid: UUID_B }],
]);

describe("planBoosterRewards", () => {
  it("grants every configured rank to linked boosters", () => {
    const { toGrant, toRevoke } = planBoosterRewards({
      enabled: true,
      rankGroups: ["booster", "Supporter"],
      boosterDiscordIds: new Set(["100"]),
      linkedByDiscordId: linked,
      grants: [],
    });
    expect(toGrant.map((g) => `${g.userId}:${g.rankGroup}`).sort()).toEqual(["1:booster", "1:supporter"]);
    expect(toRevoke).toEqual([]);
  });

  it("ignores boosters without a real linked account", () => {
    const { toGrant } = planBoosterRewards({
      enabled: true,
      rankGroups: ["booster"],
      boosterDiscordIds: new Set(["999"]),
      linkedByDiscordId: linked,
      grants: [],
    });
    expect(toGrant).toEqual([]);
  });

  it("revokes when the boost ends, and does nothing for grants already in place", () => {
    const grants = [
      { userId: 1, discordId: "100", uuid: UUID_A, rankGroup: "booster" },
      { userId: 2, discordId: "200", uuid: UUID_B, rankGroup: "booster" },
    ];
    const { toGrant, toRevoke } = planBoosterRewards({
      enabled: true,
      rankGroups: ["booster"],
      boosterDiscordIds: new Set(["100"]),
      linkedByDiscordId: linked,
      grants,
    });
    expect(toGrant).toEqual([]);
    expect(toRevoke.map((g) => g.userId)).toEqual([2]);
  });

  it("revokes a rank removed from the configured list", () => {
    const { toRevoke } = planBoosterRewards({
      enabled: true,
      rankGroups: ["booster"],
      boosterDiscordIds: new Set(["100"]),
      linkedByDiscordId: linked,
      grants: [{ userId: 1, discordId: "100", uuid: UUID_A, rankGroup: "oldrank" }],
    });
    expect(toRevoke.map((g) => g.rankGroup)).toEqual(["oldrank"]);
  });

  it("revokes everything when the feature is turned off", () => {
    const { toGrant, toRevoke } = planBoosterRewards({
      enabled: false,
      rankGroups: ["booster"],
      boosterDiscordIds: new Set(["100"]),
      linkedByDiscordId: linked,
      grants: [{ userId: 1, discordId: "100", uuid: UUID_A, rankGroup: "booster" }],
    });
    expect(toGrant).toEqual([]);
    expect(toRevoke).toHaveLength(1);
  });
});

describe("buildRankCommand", () => {
  it("builds add and remove commands against the player uuid", () => {
    expect(buildRankCommand("add", UUID_A, "Booster")).toBe(`lp user ${UUID_A} parent add booster`);
    expect(buildRankCommand("remove", UUID_A, "booster")).toBe(`lp user ${UUID_A} parent remove booster`);
  });

  it("refuses anything that could change the command's shape", () => {
    expect(() => buildRankCommand("add", UUID_A, "booster permission set *")).toThrow();
    expect(() => buildRankCommand("add", UUID_A, "booster\nop x")).toThrow();
    expect(() => buildRankCommand("add", "not-a-uuid", "booster")).toThrow();
    expect(() => buildRankCommand("delete", UUID_A, "booster")).toThrow();
  });
});

describe("rank group settings", () => {
  it("normalises and de-duplicates group names, dropping invalid ones", () => {
    expect(normaliseRankGroups(["Booster", "booster", " vip ", "bad name", ""])).toEqual(["booster", "vip"]);
  });

  it("rejects an invalid rank name on the settings page", () => {
    const field = findField("discord.boosterRewards.rankGroups");
    expect(parseFieldValue(field, "booster\nvip")).toEqual({ ok: true, value: ["booster", "vip"] });
    expect(parseFieldValue(field, "booster\nbad name").ok).toBe(false);
  });
});
