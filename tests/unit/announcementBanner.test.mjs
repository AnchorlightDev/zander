/**
 * tests/unit/announcementBanner.test.mjs
 *
 * The site-wide banner: that it can be dismissed, and that dismissing one
 * banner cannot silently hide the next one.
 *
 * Renders the partial directly rather than reasoning about the source, so the
 * assertions are about what a visitor actually receives.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ejs = require("ejs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = join(repoRoot, "views/partials/announcementWeb.ejs");
const template = readFileSync(file, "utf8");

const render = (announcementData) =>
  ejs.render(template, { announcementData }, { filename: file });

const banner = (over = {}) => ({
  announcementId: 7,
  body: "Safe Server is live.",
  link: "/rules",
  updatedDate: new Date("2026-01-05T09:00:00.000Z"),
  ...over,
});

describe("rendering", () => {
  it("renders nothing at all when there is no announcement", () => {
    expect(render(null).trim()).toBe("");
    expect(render(undefined).trim()).toBe("");
  });

  it("renders the body and the link", () => {
    const html = render(banner());

    expect(html).toContain("Safe Server is live.");
    expect(html).toContain('href="/rules"');
  });

  it("renders without a link when there is none", () => {
    const html = render(banner({ link: null }));

    expect(html).toContain("Safe Server is live.");
    expect(html).not.toContain("Click me for more information.");
  });
});

describe("dismissal", () => {
  it("offers a dismiss control", () => {
    const html = render(banner());

    expect(html).toContain("announcementWebBanner-dismiss");
    expect(html).toContain('aria-label="Dismiss this announcement"');
  });

  it("keys the dismissal to the announcement id", () => {
    // Dismissing one banner must not hide the next one that appears.
    expect(render(banner({ announcementId: 7 }))).toContain("zander.ann.7.");
    expect(render(banner({ announcementId: 8 }))).toContain("zander.ann.8.");
  });

  it("keys it to the content version as well, so an edit brings it back", () => {
    const original = render(banner());
    const edited = render(banner({ updatedDate: new Date("2026-06-01T09:00:00.000Z") }));

    const keyOf = (html) => html.match(/data-announcement-key="([^"]+)"/)[1];

    expect(keyOf(original)).not.toBe(keyOf(edited));
    expect(keyOf(original)).toBe("zander.ann.7." + new Date("2026-01-05T09:00:00.000Z").getTime());
  });

  it("still produces a usable key when the row has never been updated", () => {
    expect(render(banner({ updatedDate: null }))).toContain('data-announcement-key="zander.ann.7.0"');
  });

  it("puts the dismiss button outside the link", () => {
    // It used to be one <a> around the whole banner; a <button> inside an <a>
    // is invalid and does not reliably receive the click.
    const html = render(banner());
    const anchorEnd = html.indexOf("</a>");
    const buttonStart = html.indexOf("<button");

    expect(anchorEnd).toBeGreaterThan(-1);
    expect(buttonStart).toBeGreaterThan(anchorEnd);
  });

  it("guards every localStorage access", () => {
    // Private-browsing modes throw outright on access; a banner is not worth
    // an uncaught exception on every page.
    const html = render(banner());
    const script = html.slice(html.indexOf("<script"));

    expect(script).toContain("try {");
    expect((script.match(/catch \(e\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
