import { describe, it, expect } from "vitest";
import { sanitizeForumHtml } from "../../lib/htmlSanitize.js";

describe("sanitizeForumHtml", () => {
  it("strips <script> tags entirely", () => {
    const result = sanitizeForumHtml('<p>hello</p><script>alert(1)</script>');
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert(1)");
  });

  it("strips event-handler attributes like onerror", () => {
    const result = sanitizeForumHtml('<img src="x.png" onerror="alert(1)">');
    expect(result).not.toContain("onerror");
  });

  it("neutralizes javascript: hrefs", () => {
    const result = sanitizeForumHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain("javascript:");
  });

  it("neutralizes data: srcs on img", () => {
    const result = sanitizeForumHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(result).not.toContain("data:");
  });

  it("keeps common formatting tags like strong and p", () => {
    const result = sanitizeForumHtml('<p>Hello <strong>world</strong></p>');
    expect(result).toContain("<p>");
    expect(result).toContain("<strong>world</strong>");
  });

  it("strips iframe/object/embed except allowlisted iframe hosts", () => {
    expect(sanitizeForumHtml('<object data="evil.swf"></object>')).not.toContain("<object");
    expect(sanitizeForumHtml('<embed src="evil.swf">')).not.toContain("<embed");
    expect(sanitizeForumHtml('<iframe src="https://evil.example.com/x"></iframe>')).not.toContain("evil.example.com");
    expect(sanitizeForumHtml('<iframe src="https://www.youtube.com/embed/abc"></iframe>')).toContain("youtube.com/embed/abc");
  });

  it("returns empty string for non-string/empty input", () => {
    expect(sanitizeForumHtml(null)).toBe("");
    expect(sanitizeForumHtml(undefined)).toBe("");
    expect(sanitizeForumHtml("")).toBe("");
  });
});
