import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { DEFAULT_CONFIG, DEFAULT_FEATURES, mergeDeep, assignInPlace } = require("../../lib/config/defaults.cjs");
const store = require("../../lib/config/store.cjs");
const { ALL_FIELDS, getPath } = await import("../../lib/config/settingsRegistry.mjs");

describe("built-in defaults", () => {
  it("give every editable setting a place to live", () => {
    // A registry field whose parent object is missing from the defaults
    // would crash code that reads e.g. config.discord.webhooks.welcome.
    for (const field of ALL_FIELDS) {
      const parent = field.path.split(".").slice(0, -1).join(".");
      expect(getPath(DEFAULT_CONFIG, parent), field.path).toBeTypeOf("object");
    }
  });

  it("never ship a placeholder that looks configured", () => {
    const json = JSON.stringify(DEFAULT_CONFIG);
    for (const placeholder of ["CHANNELID", "GUILDID", "ROLEID", "WEBHOOKURL", "CATEGORYID"]) {
      expect(json).not.toContain(placeholder);
    }
  });

  it("are what the shared store starts from, as copies", () => {
    expect(store.config).toEqual(DEFAULT_CONFIG);
    expect(store.features).toEqual(DEFAULT_FEATURES);
    expect(store.config).not.toBe(DEFAULT_CONFIG);
  });

  it("are the same object for every module that loads them", () => {
    expect(require("../../lib/config/config.cjs")).toBe(store.config);
    expect(require("../../lib/config/features.cjs")).toBe(store.features);
  });
});

describe("mergeDeep (legacy file over defaults)", () => {
  it("keeps defaults for keys an old file lacks", () => {
    // An old features.json from before Bedrock and Birthdays existed.
    const legacy = { webstore: false, discord: { punishments: false } };
    const merged = mergeDeep(DEFAULT_FEATURES, legacy);
    expect(merged.webstore).toBe(false);
    expect(merged.discord.punishments).toBe(false);
    expect(merged.bedrock).toBe(true);
    expect(merged.birthday).toBe(true);
    expect(merged.discord.events.nicknameCheck).toBe(true);
  });

  it("keeps keys only the old file has, and replaces arrays whole", () => {
    const merged = mergeDeep(DEFAULT_CONFIG, {
      meetings: { enabled: true },
      watch: { filters: { twitch: { tags: ["cfc"] } } },
    });
    expect(merged.meetings).toEqual({ enabled: true });
    expect(merged.watch.filters.twitch.tags).toEqual(["cfc"]);
    expect(merged.watch.filters.youtube.tags).toEqual([]);
  });

  it("does not modify its inputs", () => {
    const before = structuredClone(DEFAULT_FEATURES);
    mergeDeep(DEFAULT_FEATURES, { webstore: false });
    expect(DEFAULT_FEATURES).toEqual(before);
  });
});

describe("assignInPlace", () => {
  it("updates values without replacing nested objects others hold", () => {
    const target = { birthday: { enabled: false, rankGroup: "" }, other: 1 };
    const held = target.birthday; // e.g. cron/birthdayRankCron.js at import
    assignInPlace(target, { birthday: { enabled: true, rankGroup: "bday" }, extra: [1, 2] });
    expect(held).toEqual({ enabled: true, rankGroup: "bday" });
    expect(target.birthday).toBe(held);
    expect(target.extra).toEqual([1, 2]);
    expect(target.other).toBe(1);
  });
});
