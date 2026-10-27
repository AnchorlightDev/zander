import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import {
  ALL_FIELDS,
  MODULE_SETTINGS,
  findSection,
  hasModuleSettings,
  planSectionWrites,
} from "../../lib/config/settingsRegistry.mjs";
import { listFlagPaths } from "../../lib/config/featureRegistry.mjs";

const require = createRequire(import.meta.url);
const { DEFAULT_CONFIG, DEFAULT_FEATURES } = require("../../lib/config/defaults.cjs");

const fieldPaths = new Set(ALL_FIELDS.map((f) => f.path));
const flagPaths = new Set(listFlagPaths(DEFAULT_FEATURES));

describe("MODULE_SETTINGS", () => {
  it("only names real module switches", () => {
    for (const flag of Object.keys(MODULE_SETTINGS)) expect(flagPaths, flag).toContain(flag);
  });

  it("only lists fields the settings page can edit", () => {
    for (const [flag, entry] of Object.entries(MODULE_SETTINGS)) {
      for (const path of entry.fields || []) expect(fieldPaths, `${flag} → ${path}`).toContain(path);
    }
  });

  it("links only to dashboard pages", () => {
    for (const entry of Object.values(MODULE_SETTINGS)) {
      for (const link of entry.links || []) expect(link.href.startsWith("/dashboard/")).toBe(true);
    }
  });

  it("gives a Settings button only to modules with something to configure", () => {
    expect(hasModuleSettings("resources")).toBe(true);
    expect(hasModuleSettings("web.login")).toBe(false);
    expect(hasModuleSettings("nope")).toBe(false);
  });
});

describe("module sections", () => {
  it("resolve through findSection like any settings tab", () => {
    const section = findSection("module:resources");
    expect(section.key).toBe("module:resources");
    expect(section.fields.map((f) => f.path)).toEqual(["resources.reviewChannelId", "resources.voteWindowDays"]);
    expect(findSection("module:nope")).toBeNull();
    expect(findSection("general").key).toBe("general");
  });

  it("save only their own fields", () => {
    const section = findSection("module:resources");
    const { writes, errors } = planSectionWrites(
      section,
      { "resources.voteWindowDays": "14", "siteConfiguration.siteName": "Hacked" },
      [],
      DEFAULT_CONFIG
    );
    expect(errors).toEqual([]);
    expect(writes).toEqual([{ path: "resources.voteWindowDays", value: 14 }]);
  });
});
