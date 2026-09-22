/**
 * tests/unit/langText.test.mjs
 *
 * Reading page copy out of lang.json. Pure -- no lang file, no renderer.
 */

import { describe, expect, it } from "vitest";
import { createTranslator, fillTokens, resolveLangPath } from "../../lib/langText.mjs";

const lang = {
  api: { noToken: "There was no token included in this request." },
  bedrock: {
    heading: "Play %SITENAME% on Bedrock Edition",
    blank: "   ",
    steps: ["Open Minecraft on %DEVICE%.", "Add a server.", "Join %SITENAME%."],
    empty: [],
    notAString: 42,
  },
};

describe("fillTokens", () => {
  it("substitutes what it is given", () => {
    expect(fillTokens("Join %SITENAME% today", { SITENAME: "Example" })).toBe("Join Example today");
  });

  it("substitutes the same token more than once", () => {
    expect(fillTokens("%A% and %A%", { A: "x" })).toBe("x and x");
  });

  it("leaves an unknown token alone rather than printing undefined", () => {
    expect(fillTokens("Join %SITENAME%", {})).toBe("Join %SITENAME%");
    expect(fillTokens("Join %SITENAME%", { SITENAME: null })).toBe("Join %SITENAME%");
  });

  it("handles nothing at all", () => {
    expect(fillTokens(null)).toBe("");
    expect(fillTokens(undefined, { A: 1 })).toBe("");
  });
});

describe("resolveLangPath", () => {
  it("walks a dotted path", () => {
    expect(resolveLangPath(lang, "api.noToken")).toBe(lang.api.noToken);
    expect(resolveLangPath(lang, "bedrock.steps")).toEqual(lang.bedrock.steps);
  });

  it("returns undefined for a gap instead of throwing", () => {
    expect(resolveLangPath(lang, "nope.nothing.here")).toBeUndefined();
    expect(resolveLangPath(lang, "api.noToken.deeper")).toBeUndefined();
    expect(resolveLangPath(null, "api.noToken")).toBeUndefined();
    expect(resolveLangPath(lang, "")).toBe(lang);
  });
});

describe("createTranslator", () => {
  const t = createTranslator(lang, { SITENAME: "Example Network" });

  it("reads and fills a string", () => {
    expect(t("bedrock.heading")).toBe("Play Example Network on Bedrock Edition");
  });

  it("lets a call override a default token", () => {
    expect(t("bedrock.heading", { SITENAME: "Other" })).toBe("Play Other on Bedrock Edition");
  });

  it("gives an empty string for a missing key, never 'undefined' on the page", () => {
    expect(t("bedrock.nothingHere")).toBe("");
    expect(t("totally.absent")).toBe("");
    expect(t("bedrock.notAString")).toBe("");
  });

  it("reads a list, filling each entry", () => {
    expect(t.list("bedrock.steps", { DEVICE: "Windows" })).toEqual([
      "Open Minecraft on Windows.",
      "Add a server.",
      "Join Example Network.",
    ]);
  });

  it("gives an empty list for a gap or a non-list", () => {
    expect(t.list("bedrock.missing")).toEqual([]);
    expect(t.list("bedrock.heading")).toEqual([]);
    expect(t.list("bedrock.empty")).toEqual([]);
  });

  describe("has", () => {
    it("is true for real copy", () => {
      expect(t.has("bedrock.heading")).toBe(true);
      expect(t.has("bedrock.steps")).toBe(true);
    });

    it("is false for a gap, blank copy, or an empty list", () => {
      // This is what lets a template drop a section nobody has written yet,
      // rather than rendering an empty heading.
      expect(t.has("bedrock.missing")).toBe(false);
      expect(t.has("bedrock.blank")).toBe(false);
      expect(t.has("bedrock.empty")).toBe(false);
      expect(t.has("bedrock.notAString")).toBe(false);
    });
  });

  it("works with no defaults given", () => {
    const bare = createTranslator(lang);
    expect(bare("bedrock.heading")).toBe("Play %SITENAME% on Bedrock Edition");
  });
});
