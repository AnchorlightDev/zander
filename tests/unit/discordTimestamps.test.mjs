import { describe, it, expect } from "vitest";
import {
  renderDiscordTimestamps,
  TIMESTAMP_STYLES,
  DISCORD_TIMESTAMP_CLIENT_SCRIPT,
} from "../../lib/discordTimestamps.js";

// The epoch from the Minecraft LIVE Watch Party description that surfaced this bug.
const EPOCH = 1790442000;

describe("renderDiscordTimestamps", () => {
  it("replaces the escaped form Summernote stores", () => {
    const out = renderDiscordTimestamps(`<p>&lt;t:${EPOCH}:F&gt;</p>`);
    expect(out).toContain(`data-ts="${EPOCH}"`);
    expect(out).toContain('data-ts-style="F"');
    expect(out).not.toContain("&lt;t:");
  });

  it("replaces the raw form that arrives via the API or a Discord copy-paste", () => {
    const out = renderDiscordTimestamps(`<p><t:${EPOCH}:R></p>`);
    expect(out).toContain(`data-ts="${EPOCH}"`);
    expect(out).toContain('data-ts-style="R"');
    expect(out).not.toContain("<t:");
  });

  it("defaults to Discord's 'f' style when no suffix is given", () => {
    expect(renderDiscordTimestamps(`&lt;t:${EPOCH}&gt;`)).toContain('data-ts-style="f"');
  });

  it("handles several tokens in one description", () => {
    const html = `&lt;t:${EPOCH}:F&gt; — starts &lt;t:${EPOCH}:R&gt;`;
    const out = renderDiscordTimestamps(html);
    expect(out.match(/js-discord-ts/g)).toHaveLength(2);
    expect(out).toContain('data-ts-style="F"');
    expect(out).toContain('data-ts-style="R"');
  });

  it("supports every Discord style suffix", () => {
    for (const style of TIMESTAMP_STYLES) {
      const out = renderDiscordTimestamps(`&lt;t:${EPOCH}:${style}&gt;`);
      expect(out).toContain(`data-ts-style="${style}"`);
    }
  });

  it("emits readable UTC fallback text for readers without JavaScript", () => {
    const out = renderDiscordTimestamps(`&lt;t:${EPOCH}:F&gt;`);
    // The span must not be empty, or the page shows a gap until the script runs.
    expect(out).toMatch(/>[^<]+<\/span>/);
    expect(out).toContain("UTC");
  });

  it("renders a date-only fallback for date styles", () => {
    expect(renderDiscordTimestamps(`&lt;t:${EPOCH}:D&gt;`)).not.toContain("UTC");
  });

  it("leaves surrounding markup untouched", () => {
    const out = renderDiscordTimestamps(`<p>Starts <strong>&lt;t:${EPOCH}:F&gt;</strong> sharp</p>`);
    expect(out.startsWith("<p>Starts <strong>")).toBe(true);
    expect(out.endsWith("</strong> sharp</p>")).toBe(true);
  });

  it("returns non-string input unchanged", () => {
    expect(renderDiscordTimestamps(null)).toBeNull();
    expect(renderDiscordTimestamps(undefined)).toBeUndefined();
    expect(renderDiscordTimestamps("")).toBe("");
  });

  it("leaves text with no tokens exactly as it was", () => {
    const html = "<p>No timestamps here.</p>";
    expect(renderDiscordTimestamps(html)).toBe(html);
  });

  it("ignores a malformed token rather than mangling it", () => {
    expect(renderDiscordTimestamps("&lt;t:abc:F&gt;")).toBe("&lt;t:abc:F&gt;");
    expect(renderDiscordTimestamps("&lt;t:&gt;")).toBe("&lt;t:&gt;");
  });

  it("ignores an unknown style suffix instead of emitting it", () => {
    // <t:123:Z> is not valid Discord syntax; it must not reach the output.
    const out = renderDiscordTimestamps(`&lt;t:${EPOCH}:Z&gt;`);
    expect(out).not.toContain('data-ts-style="Z"');
  });

  it("cannot be used to inject markup through the epoch", () => {
    // The pattern only admits digits, so a crafted token is left as inert text.
    const attack = '&lt;t:1"><img src=x onerror=alert(1)>:F&gt;';
    const out = renderDiscordTimestamps(attack);
    expect(out).not.toContain("js-discord-ts");
    expect(out).toBe(attack);
  });

  it("refuses an epoch beyond a safe integer", () => {
    const huge = "9".repeat(14);
    const out = renderDiscordTimestamps(`&lt;t:${huge}:F&gt;`);
    // 14 nines is still a safe integer, so it renders; the guard is that
    // nothing longer is matched at all.
    expect(out).toContain("js-discord-ts");
    expect(renderDiscordTimestamps(`&lt;t:${"9".repeat(15)}:F&gt;`)).not.toContain("js-discord-ts");
  });
});

describe("DISCORD_TIMESTAMP_CLIENT_SCRIPT", () => {
  it("is valid JavaScript", () => {
    expect(() => new Function(DISCORD_TIMESTAMP_CLIENT_SCRIPT)).not.toThrow();
  });

  it("contains no closing script tag that would break the inline block", () => {
    expect(DISCORD_TIMESTAMP_CLIENT_SCRIPT).not.toContain("</script");
  });

  it("handles every absolute style the renderer can emit", () => {
    // 'R' is relative and takes its own branch above the options map.
    for (const style of TIMESTAMP_STYLES.filter((s) => s !== "R")) {
      expect(DISCORD_TIMESTAMP_CLIENT_SCRIPT).toContain(`${style}: {`);
    }
  });

  it("handles the relative style separately", () => {
    expect(DISCORD_TIMESTAMP_CLIENT_SCRIPT).toContain("style === 'R'");
    expect(DISCORD_TIMESTAMP_CLIENT_SCRIPT).toContain("ago");
  });
});
