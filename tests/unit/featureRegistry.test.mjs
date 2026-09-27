import { describe, it, expect } from "vitest";
import {
  LOCKED_FLAGS,
  describeFlags,
  listFlagPaths,
  planFlagWrites,
} from "../../lib/config/featureRegistry.mjs";
import { getPath } from "../../lib/config/settingsRegistry.mjs";

const baseline = {
  webstore: true,
  events: false,
  discord: { punishments: true, events: { nicknameCheck: true } },
  web: { login: true, register: true },
  smReddit: false,
  notAFlag: "ignored",
};

describe("listFlagPaths", () => {
  it("finds every boolean at any depth and ignores non-booleans", () => {
    expect(listFlagPaths(baseline).sort()).toEqual([
      "discord.events.nicknameCheck",
      "discord.punishments",
      "events",
      "smReddit",
      "web.login",
      "web.register",
      "webstore",
    ]);
  });
});

describe("describeFlags", () => {
  it("groups flags and labels unknown ones from their key", () => {
    const groups = describeFlags(baseline);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.flags.map((f) => f.path)]));
    expect(byKey.modules).toEqual(["webstore", "events"]);
    expect(byKey.discord).toContain("discord.events.nicknameCheck");
    expect(byKey.social).toEqual(["smReddit"]);
    const reddit = groups.find((g) => g.key === "social").flags[0];
    expect(reddit.label).toBe("Reddit");
  });

  it("marks login as locked", () => {
    const login = describeFlags(baseline).flatMap((g) => g.flags).find((f) => f.path === "web.login");
    expect(login.locked).toBe(true);
    expect(LOCKED_FLAGS.has("web.login")).toBe(true);
  });

  it("covers every flag in the real features.json", async () => {
    const { createRequire } = await import("module");
    const features = createRequire(import.meta.url)("../../features.json");
    const described = describeFlags(features).flatMap((g) => g.flags).map((f) => f.path).sort();
    expect(described).toEqual(listFlagPaths(features).sort());
  });
});

describe("planFlagWrites", () => {
  it("treats an absent checkbox as off and stores only differences from the file", () => {
    const writes = planFlagWrites({ webstore: "1", events: "1", "discord.punishments": "1" }, baseline, getPath);
    const byPath = Object.fromEntries(writes.map((w) => [w.path, w.value]));
    expect(byPath.webstore).toBeNull(); // on, and on in the file
    expect(byPath.events).toBe(true); // on, off in the file
    expect(byPath["discord.events.nicknameCheck"]).toBe(false); // absent, on in the file
    expect(byPath["web.register"]).toBe(false);
  });

  it("never writes a locked flag, even if the form tries to switch it off", () => {
    const writes = planFlagWrites({}, baseline, getPath);
    expect(writes.find((w) => w.path === "web.login")).toBeUndefined();
  });
});
