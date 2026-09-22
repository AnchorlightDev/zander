/**
 * tests/unit/sitemapCoverage.test.mjs
 *
 * The sitemap's two invariants:
 *
 *   a disabled page must never be listed, and
 *   a public, indexable page must not be forgotten.
 *
 * The first is a correctness bug (submitting URLs that serve a "feature
 * disabled" page). The second is the quieter one -- /vault, /forums and
 * /webstore were all public and all missing, which is invisible until you
 * notice they never rank.
 */

import { describe, expect, it } from "vitest";
import { staticSitemapPages } from "../../routes/sitemapRoute.js";

const ALL_ON = {
  server: true,
  bedrock: true,
  ranks: true,
  vault: true,
  forums: true,
  webstore: true,
  applications: true,
  watch: true,
  events: true,
  shopdirectory: true,
  report: true,
  discord: { punishments: true },
};

const urls = (features) => staticSitemapPages(features).map((p) => p.url);

describe("feature flags are respected", () => {
  it("lists the gated pages when their features are on", () => {
    const listed = urls(ALL_ON);

    for (const url of ["/play", "/bedrock", "/ranks", "/vault", "/forums", "/webstore",
                       "/apply", "/watch", "/events", "/shopdirectory", "/punishments", "/report"]) {
      expect(listed, url).toContain(url);
    }
  });

  it("lists none of them when every feature is off", () => {
    const listed = urls({});

    for (const url of ["/play", "/bedrock", "/ranks", "/vault", "/forums", "/webstore",
                       "/apply", "/watch", "/events", "/shopdirectory", "/punishments", "/report"]) {
      expect(listed, url).not.toContain(url);
    }
  });

  it("turns one page off without touching the others", () => {
    const listed = urls({ ...ALL_ON, vault: false });

    expect(listed).not.toContain("/vault");
    expect(listed).toContain("/forums");
    expect(listed).toContain("/ranks");
  });

  it("reads the nested punishments flag correctly", () => {
    expect(urls({ discord: { punishments: false } })).not.toContain("/punishments");
    expect(urls({ discord: {} })).not.toContain("/punishments");
    expect(urls({})).not.toContain("/punishments");
  });
});

describe("pages served unconditionally are always listed", () => {
  it("keeps the home page, policies and the always-on routes", () => {
    const listed = urls({});

    for (const url of ["/", "/finance", "/staff", "/appeal", "/rules", "/terms", "/privacy", "/refund"]) {
      expect(listed, url).toContain(url);
    }
  });
});

describe("the entries themselves are well formed", () => {
  const pages = staticSitemapPages(ALL_ON);

  it("has no duplicates", () => {
    const listed = pages.map((p) => p.url);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("gives every page a root-relative url, a priority and a changefreq", () => {
    for (const page of pages) {
      expect(page.url.startsWith("/"), page.url).toBe(true);
      expect(Number(page.priority), page.url).toBeGreaterThan(0);
      expect(Number(page.priority), page.url).toBeLessThanOrEqual(1);
      expect(
        ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"],
        page.url
      ).toContain(page.changefreq);
    }
  });

  it("puts the home page first and at top priority", () => {
    expect(pages[0].url).toBe("/");
    expect(pages[0].priority).toBe("1.0");
  });

  it("lists nothing that robots.txt disallows", () => {
    // Submitting a URL you have told crawlers not to fetch is the
    // "Indexed, though blocked by robots.txt" trap.
    for (const page of pages) {
      expect(page.url.startsWith("/api/"), page.url).toBe(false);
      expect(page.url, page.url).not.toBe("/logout");
    }
  });
});
