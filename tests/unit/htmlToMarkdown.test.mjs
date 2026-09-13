import { describe, it, expect, vi } from "vitest";

// Mock the entire discord client so eventDiscordService loads cleanly
vi.mock("../../controllers/discordController.js", () => ({ client: null }));
vi.mock("../../services/eventService.js", () => ({
  updateSyncStatus: vi.fn(),
  logEventAudit: vi.fn(),
}));
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    SapphireClient: class { constructor() {} },
  };
});

const { htmlToMarkdown } = await import("../../services/eventDiscordService.js");

describe("htmlToMarkdown", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
    expect(htmlToMarkdown("")).toBe("");
  });

  it("converts <strong> to bold", () => {
    expect(htmlToMarkdown("<strong>hello</strong>")).toBe("**hello**");
  });

  it("converts <b> to bold", () => {
    expect(htmlToMarkdown("<b>hello</b>")).toBe("**hello**");
  });

  it("converts <em> to italic", () => {
    expect(htmlToMarkdown("<em>hello</em>")).toBe("*hello*");
  });

  it("converts <i> to italic", () => {
    expect(htmlToMarkdown("<i>hello</i>")).toBe("*hello*");
  });

  it("converts <u> to underline", () => {
    expect(htmlToMarkdown("<u>hello</u>")).toBe("__hello__");
  });

  it("converts <s> to strikethrough", () => {
    expect(htmlToMarkdown("<s>hello</s>")).toBe("~~hello~~");
  });

  it("converts <del> to strikethrough", () => {
    expect(htmlToMarkdown("<del>hello</del>")).toBe("~~hello~~");
  });

  it("converts <code> to inline code", () => {
    expect(htmlToMarkdown("<code>foo()</code>")).toBe("`foo()`");
  });

  it("converts <h1>-<h3> to bold", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toContain("**Title**");
    expect(htmlToMarkdown("<h2>Title</h2>")).toContain("**Title**");
    expect(htmlToMarkdown("<h3>Title</h3>")).toContain("**Title**");
  });

  it("converts <h4>-<h6> to plain line", () => {
    const result = htmlToMarkdown("<h4>Sub</h4>");
    expect(result).toContain("Sub");
    expect(result).not.toContain("**Sub**");
  });

  it("converts <a> to markdown link", () => {
    expect(htmlToMarkdown('<a href="https://example.com">click here</a>')).toBe(
      "[click here](https://example.com)"
    );
  });

  it("uses href directly for empty anchor text", () => {
    expect(htmlToMarkdown('<a href="https://example.com"></a>')).toBe("https://example.com");
  });

  it("converts <li> to bullet points", () => {
    const result = htmlToMarkdown("<ul><li>Item one</li><li>Item two</li></ul>");
    expect(result).toContain("• Item one");
    expect(result).toContain("• Item two");
  });

  it("converts <br> to newline", () => {
    expect(htmlToMarkdown("line1<br>line2")).toBe("line1\nline2");
    expect(htmlToMarkdown("line1<br/>line2")).toBe("line1\nline2");
  });

  it("converts </p> to double newline and strips <p>", () => {
    const result = htmlToMarkdown("<p>Para one</p><p>Para two</p>");
    expect(result).toContain("Para one");
    expect(result).toContain("Para two");
  });

  it("strips unknown tags", () => {
    expect(htmlToMarkdown("<span>hello</span>")).toBe("hello");
    expect(htmlToMarkdown("<div>world</div>")).toBe("world");
  });

  it("decodes HTML entities", () => {
    expect(htmlToMarkdown("&amp;")).toBe("&");
    expect(htmlToMarkdown("&lt;")).toBe("<");
    expect(htmlToMarkdown("&gt;")).toBe(">");
    expect(htmlToMarkdown("&quot;")).toBe('"');
    expect(htmlToMarkdown("&#39;")).toBe("'");
    // &nbsp; alone is trimmed to empty; embedded between chars it becomes a space
    expect(htmlToMarkdown("a&nbsp;b")).toBe("a b");
  });

  it("collapses more than two consecutive newlines", () => {
    const result = htmlToMarkdown("a<br><br><br><br>b");
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("trims leading and trailing whitespace", () => {
    expect(htmlToMarkdown("  <b>hello</b>  ")).toBe("**hello**");
  });

  it("handles mixed inline formatting", () => {
    const result = htmlToMarkdown("<strong>bold</strong> and <em>italic</em>");
    expect(result).toBe("**bold** and *italic*");
  });
});
