import { describe, it, expect } from "vitest";
import {
  ALL_FIELDS,
  SETTINGS_SECTIONS,
  applyOverrides,
  findField,
  findSection,
  maskSecret,
  parseFieldValue,
  planSectionWrites,
  setPath,
} from "../../lib/config/settingsRegistry.mjs";

const field = (path) => findField(path);
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_-123";

describe("registry shape", () => {
  it("has unique paths and section keys", () => {
    const paths = ALL_FIELDS.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    const keys = SETTINGS_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every select field its options", () => {
    for (const f of ALL_FIELDS.filter((f) => f.type === "select")) {
      expect(Array.isArray(f.options) && f.options.length > 0).toBe(true);
    }
  });

  it("fits every storage key in the siteSettings VARCHAR(100)", () => {
    for (const f of ALL_FIELDS) expect(`config:${f.path}`.length).toBeLessThanOrEqual(100);
  });
});

describe("parseFieldValue", () => {
  it("accepts Discord IDs and blanks them to null", () => {
    expect(parseFieldValue(field("discord.guildId"), " 123456789012345678 ")).toEqual({ ok: true, value: "123456789012345678" });
    expect(parseFieldValue(field("discord.guildId"), "")).toEqual({ ok: true, value: null });
    expect(parseFieldValue(field("discord.guildId"), "GUILDID").ok).toBe(false);
  });

  it("only accepts Discord webhook URLs", () => {
    expect(parseFieldValue(field("discord.webhooks.welcome"), WEBHOOK)).toEqual({ ok: true, value: WEBHOOK });
    expect(parseFieldValue(field("discord.webhooks.welcome"), "https://evil.example/api/webhooks/1/x").ok).toBe(false);
  });

  it("validates ports and allows blank", () => {
    expect(parseFieldValue(field("connection.java.port"), "25565")).toEqual({ ok: true, value: 25565 });
    expect(parseFieldValue(field("connection.java.port"), "")).toEqual({ ok: true, value: null });
    expect(parseFieldValue(field("connection.java.port"), "70000").ok).toBe(false);
  });

  it("strips trailing slashes from URLs and rejects non-http schemes", () => {
    expect(parseFieldValue(field("siteConfiguration.siteUrl"), "https://example.net/")).toEqual({ ok: true, value: "https://example.net" });
    expect(parseFieldValue(field("siteConfiguration.platforms.discord"), "javascript:alert(1)").ok).toBe(false);
  });

  it("enforces required fields", () => {
    expect(parseFieldValue(field("siteConfiguration.siteName"), "   ").ok).toBe(false);
  });

  it("splits lists on newlines and commas", () => {
    expect(parseFieldValue(field("watch.filters.twitch.tags"), "cfc\r\n faith ,, \n")).toEqual({ ok: true, value: ["cfc", "faith"] });
  });

  it("parses checkboxes, times, timezones and selects", () => {
    expect(parseFieldValue(field("birthday.enabled"), "1").value).toBe(true);
    expect(parseFieldValue(field("birthday.enabled"), undefined).value).toBe(false);
    expect(parseFieldValue(field("staffAuditReport.time"), "24:00").ok).toBe(false);
    expect(parseFieldValue(field("staffAuditReport.timezone"), "Australia/Sydney").value).toBe("Australia/Sydney");
    expect(parseFieldValue(field("staffAuditReport.timezone"), "AEDT").ok).toBe(false);
    expect(parseFieldValue(field("staffAuditReport.dayOfWeek"), "Funday").ok).toBe(false);
  });

  it("checks region code patterns", () => {
    expect(parseFieldValue(field("siteConfiguration.region.countryCode"), "AU").ok).toBe(true);
    expect(parseFieldValue(field("siteConfiguration.region.countryCode"), "AUS").ok).toBe(false);
  });
});

describe("maskSecret", () => {
  it("never shows the webhook token", () => {
    const masked = maskSecret(WEBHOOK);
    expect(masked).not.toContain("abcDEF_-");
    expect(maskSecret("")).toBe("");
  });
});

describe("planSectionWrites", () => {
  const discord = findSection("discord");
  const baseline = {
    discord: { guildId: "111111111111111111", webhooks: { welcome: WEBHOOK }, punishments: { requireDmSuccess: false } },
  };

  it("keeps a secret when its box is left blank", () => {
    const { writes } = planSectionWrites(discord, { "discord.webhooks.welcome": "" }, [], baseline);
    expect(writes.find((w) => w.path === "discord.webhooks.welcome")).toBeUndefined();
  });

  it("stores a value equal to config.json as no override", () => {
    const { writes } = planSectionWrites(discord, { "discord.guildId": "111111111111111111" }, [], baseline);
    expect(writes.find((w) => w.path === "discord.guildId")).toEqual({ path: "discord.guildId", value: null });
  });

  it("stores a changed value as an override", () => {
    const { writes } = planSectionWrites(discord, { "discord.guildId": "222222222222222222" }, [], baseline);
    expect(writes.find((w) => w.path === "discord.guildId").value).toBe("222222222222222222");
  });

  it("treats an absent checkbox as unchecked", () => {
    const { writes } = planSectionWrites(discord, {}, [], { discord: { punishments: { requireDmSuccess: true } } });
    expect(writes.find((w) => w.path === "discord.punishments.requireDmSuccess").value).toBe(false);
  });

  it("clears reset fields back to config.json", () => {
    const { writes } = planSectionWrites(discord, { "discord.guildId": "222222222222222222" }, ["discord.guildId"], baseline);
    expect(writes.find((w) => w.path === "discord.guildId")).toEqual({ path: "discord.guildId", value: null });
  });

  it("writes nothing if any field is invalid", () => {
    const result = planSectionWrites(discord, { "discord.guildId": "222222222222222222", "discord.botChannelId": "nope" }, [], baseline);
    expect(result.writes).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});

describe("applyOverrides", () => {
  it("overlays overrides in place and falls back to config.json for unset ones", () => {
    const baseline = { siteConfiguration: { siteName: "File Name", tagline: "File tagline" }, birthday: { durationHours: 24 } };
    const config = structuredClone(baseline);
    const birthdayRef = config.birthday; // a module holding a reference at import time

    applyOverrides(config, baseline, new Map([
      ["siteConfiguration.siteName", "Dashboard Name"],
      ["siteConfiguration.tagline", null],
      ["birthday.durationHours", 48],
    ]));

    expect(config.siteConfiguration.siteName).toBe("Dashboard Name");
    expect(config.siteConfiguration.tagline).toBe("File tagline");
    expect(birthdayRef.durationHours).toBe(48);

    // Clearing the override puts the file value back.
    applyOverrides(config, baseline, new Map());
    expect(config.siteConfiguration.siteName).toBe("File Name");
    expect(birthdayRef.durationHours).toBe(24);
  });

  it("does not invent keys for fields absent from both", () => {
    const config = { siteConfiguration: { siteName: "x" } };
    applyOverrides(config, structuredClone(config), new Map());
    expect(config.wrapped).toBeUndefined();
  });

  it("creates nested objects when an override targets a missing section", () => {
    const config = {};
    applyOverrides(config, {}, new Map([["connection.java.host", "play.example.net"]]));
    expect(config.connection.java.host).toBe("play.example.net");
  });
});

describe("setPath", () => {
  it("replaces a non-object in the way", () => {
    const obj = { a: "string" };
    setPath(obj, "a.b", 1);
    expect(obj).toEqual({ a: { b: 1 } });
  });
});
