import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const meetingsViewDir = join(repoRoot, "views", "dashboard", "meetings");

/**
 * Meeting titles and time-slot labels are free text written by whoever holds
 * zander.web.meetings.manage, and they are rendered to every invitee who opens
 * the poll.  They are untrusted output.
 *
 * Two shapes of stored XSS were live here and are guarded below:
 *
 *   1. Raw JSON in a single-quoted attribute — data-options='<%- ... %>'.
 *      JSON.stringify does not escape the apostrophe, so a label of
 *      `x' onmouseover='alert(1)` closed the attribute and added a handler.
 *
 *   2. Raw JSON in a <script type="application/json"> block.  JSON.stringify
 *      does not escape the forward slash, so a label containing a closing
 *      script tag ended the block and injected markup.
 *
 * CSP does not cover this: lib/csp.js is mounted with enforce=false (report
 * only) in app.js, so neither payload would be blocked in a browser.
 */
const templates = readdirSync(meetingsViewDir).filter((f) => f.endsWith(".ejs"));

describe("meetings views escape untrusted poll data", () => {
  it("finds the meeting templates", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  for (const file of templates) {
    const path = join(meetingsViewDir, file);
    const source = readFileSync(path, "utf8");

    it(`${file} compiles`, () => {
      expect(() => ejs.compile(source, { filename: path })).not.toThrow();
    });

    it(`${file} uses no raw interpolation outside of include()`, () => {
      // <%- bypasses escaping.  Including a partial is the only legitimate use
      // in these templates; anything else is poll data going out unescaped.
      const offenders = (source.match(/<%-[^%]*%>/g) || []).filter(
        (tag) => !tag.includes("include(")
      );

      expect({ file: relative(repoRoot, path), offenders }).toEqual({
        file: relative(repoRoot, path),
        offenders: [],
      });
    });

    it(`${file} has no single-quoted data- attribute holding JSON`, () => {
      // A single-quoted attribute cannot safely hold JSON.stringify output:
      // the escaped form uses &#39;, but raw output would not.
      const offenders = source.match(/data-[\w-]+='[^']*JSON\.stringify/g) || [];
      expect(offenders).toEqual([]);
    });

    it(`${file} embeds no JSON inside a script block`, () => {
      const offenders = source.match(/<script[^>]*application\/json/g) || [];
      expect(offenders).toEqual([]);
    });
  }
});

describe("escaped interpolation actually neutralises the payloads", () => {
  const HOSTILE = `x' onmouseover='alert(1)</script><script>alert(2)</script>`;
  const payload = JSON.stringify([{ optionId: 1, label: HOSTILE }]);

  it("leaves no raw quote or angle bracket in the attribute value", () => {
    const html = ejs.render(`<div data-options="<%= j %>"></div>`, { j: payload });
    const value = html.match(/data-options="([^"]*)"/)[1];

    expect(value).not.toContain(`'`);
    expect(value).not.toContain(`"`);
    expect(value).not.toContain("<");
    expect(value).not.toContain(">");
  });

  it("still round-trips to the original JSON once the browser decodes it", () => {
    const html = ejs.render(`<div data-options="<%= j %>"></div>`, { j: payload });
    const value = html.match(/data-options="([^"]*)"/)[1];

    // What the browser does to an attribute value before dataset exposes it.
    const decoded = value
      .replace(/&#34;/g, `"`)
      .replace(/&#39;/g, `'`)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");

    expect(JSON.parse(decoded)[0].label).toBe(HOSTILE);
  });

  it("demonstrates the raw form was genuinely exploitable", () => {
    // Guards the guard: if EJS ever stopped differing here, the tests above
    // would pass for the wrong reason.
    const raw = ejs.render(`<div data-options='<%- j %>'></div>`, { j: payload });

    expect(raw).toContain(`onmouseover='alert(1)`);
    expect(raw).toContain("</script><script>");
  });
});
