import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAppealTitleFor, appealKeyFromTitle } from "../../lib/appealTitle.mjs";
import { clipEmbedText, EMBED_TITLE_MAX, EMBED_DESCRIPTION_MAX } from "../../lib/discord/embedText.mjs";
import { platformRedirectTarget } from "../../routes/redirectRoutes.js";

describe("appeal ticket title matching", () => {
  it("matches the exact punishment key only", () => {
    const title = "Appeal #123 - ban - 1 January 2026";
    expect(isAppealTitleFor(title, "123")).toBe(true);
    expect(isAppealTitleFor(title, 123)).toBe(true);
    expect(isAppealTitleFor(title, "12")).toBe(false);
    expect(isAppealTitleFor(title, "1234")).toBe(false);
  });

  it("handles fallback keys and non-appeal titles", () => {
    expect(isAppealTitleFor("Appeal #ban-1700000000000 - ban - x", "ban-1700000000000")).toBe(true);
    expect(isAppealTitleFor("Help with my plot", "12")).toBe(false);
    expect(isAppealTitleFor(null, "12")).toBe(false);
    expect(appealKeyFromTitle("Appeal #42 - mute - x")).toBe("42");
  });
});

describe("clipEmbedText", () => {
  it("leaves short text alone", () => {
    expect(clipEmbedText("hello", EMBED_TITLE_MAX)).toBe("hello");
    expect(clipEmbedText(null, EMBED_TITLE_MAX)).toBe("");
  });

  it("cuts long text to the limit with an ellipsis", () => {
    const title = clipEmbedText(`Ticket #123456: ${"x".repeat(255)}`, EMBED_TITLE_MAX);
    expect(title.length).toBe(EMBED_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(clipEmbedText("y".repeat(5000), EMBED_DESCRIPTION_MAX).length).toBe(EMBED_DESCRIPTION_MAX);
  });
});

describe("platformRedirectTarget", () => {
  it("accepts http(s) URLs", () => {
    expect(platformRedirectTarget("https://discord.gg/abc")).toBe("https://discord.gg/abc");
    expect(platformRedirectTarget("  http://example.com/issues ")).toBe("http://example.com/issues");
  });

  it("rejects blank, missing and non-http values", () => {
    expect(platformRedirectTarget("")).toBeNull();
    expect(platformRedirectTarget(undefined)).toBeNull();
    expect(platformRedirectTarget("javascript:alert(1)")).toBeNull();
    expect(platformRedirectTarget("/local")).toBeNull();
  });
});

describe("wrapped deck view", () => {
  it("escapes '<' in every raw output inside the inline script", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../views/wrapped/show.ejs", import.meta.url)),
      "utf8"
    );
    const raw = src.match(/<%-[\s\S]*?%>/g) || [];
    expect(raw.length).toBeGreaterThan(0);
    for (const tag of raw) {
      if (/include\(/.test(tag)) continue;
      expect(tag).toMatch(/u003c/);
    }
  });
});
