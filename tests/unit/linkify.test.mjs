import { describe, it, expect } from "vitest";
import { linkifyHtml, sanitizeForumHtml } from "../../lib/htmlSanitize.js";

describe("linkifyHtml", () => {
  it("links a bare URL and leaves trailing punctuation outside", () => {
    const out = linkifyHtml("<p>Visit https://map.craftingforchrist.net . Or https://x.com/a.</p>");
    expect(out).toContain('<a href="https://map.craftingforchrist.net" target="_blank" rel="noopener noreferrer nofollow">https://map.craftingforchrist.net</a> .');
    expect(out).toContain('>https://x.com/a</a>.');
  });

  it("stops at &nbsp; and links www. with https", () => {
    const out = linkifyHtml("<p>see www.example.com&nbsp;now</p>");
    expect(out).toContain('<a href="https://www.example.com"');
    expect(out).toContain("</a>&nbsp;now");
  });

  it("does not double-link or touch code", () => {
    const html = '<p><a href="https://a.com">https://a.com</a> <code>https://b.com</code></p>';
    expect(linkifyHtml(html)).toBe(html);
    expect(linkifyHtml(linkifyHtml("<p>https://c.com</p>"))).toBe(linkifyHtml("<p>https://c.com</p>"));
  });

  it("does not link inside attributes", () => {
    const html = '<p><img src="https://img.example/x.png"></p>';
    expect(linkifyHtml(html)).toBe(html);
  });

  it("sanitizeForumHtml links URLs and keeps them safe", () => {
    const out = sanitizeForumHtml('<p>https://ok.example/"><script>x</script></p>');
    expect(out).not.toContain("<script");
    expect(out).toContain('href="https://ok.example/');
  });
});
