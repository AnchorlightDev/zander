import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DISALLOW } from "../../routes/sitemapRoute.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(repoRoot, p), "utf8");

/**
 * robots.txt governs crawling, not indexing.
 *
 * Search Console reported both "Blocked by robots.txt" and "Indexed, though
 * blocked by robots.txt".  The second is the problem: a URL that is linked
 * from the site (every page's nav links to /login and /register) still gets
 * indexed when it is Disallow-ed — as a bare URL with no title or snippet,
 * because the crawler was never allowed to fetch it.
 *
 * The trap is that blocking also hides the page's own
 * <meta name="robots" content="noindex">.  The crawler must fetch the page to
 * read that tag, so Disallow + noindex means the page is never dropped.
 *
 * Invariant: a page that renders HTML and should stay out of the index must be
 * crawlable and declare noindex itself.  It must not appear in DISALLOW.
 */

/** Auth / account utility pages: crawlable, but must declare noindex. */
const NOINDEX_VIEWS = [
  "views/session/login.ejs",
  "views/session/register.ejs",
  "views/session/registerMinecraft.ejs",
  "views/session/registerVerifyEmail.ejs",
  "views/session/forgotPassword.ejs",
  "views/session/forgotPasswordVerify.ejs",
  "views/session/resetPassword.ejs",
  "views/session/notLoggedIn.ejs",
  "views/session/unregistered.ejs",
  "views/modules/notifications/index.ejs",
];

/** URL prefixes served as HTML that must stay crawlable for noindex to work. */
const MUST_STAY_CRAWLABLE = [
  "/login",
  "/register",
  "/notifications",
  "/dashboard/",
  "/account",
];

describe("robots.txt disallow list", () => {
  it("does not block any HTML surface that relies on a noindex meta tag", () => {
    const offenders = MUST_STAY_CRAWLABLE.filter((path) =>
      DISALLOW.some((blocked) => path.startsWith(blocked) || blocked.startsWith(path))
    );

    // Re-adding one of these is the exact change that caused
    // "Indexed, though blocked by robots.txt".
    expect(offenders).toEqual([]);
  });

  it("still blocks the API, which has no markup to carry a meta tag", () => {
    expect(DISALLOW).toContain("/api/");
  });

  it("lists no path that does not correspond to a real route", () => {
    // "/account" sat here for a while with no route behind it.
    const routeSources = [
      "routes/sessionRoutes.js",
      "routes/notificationRoutes.js",
      "routes/index.js",
    ]
      .map(read)
      .join("\n");

    const dead = DISALLOW.filter((path) => {
      if (path === "/api/") return false; // registered across api/routes/*
      return !routeSources.includes(`"${path.replace(/\/$/, "")}`);
    });

    expect(dead).toEqual([]);
  });
});

describe("pages excluded from search declare it in their own markup", () => {
  for (const view of NOINDEX_VIEWS) {
    it(`${view} sets pageRobots to noindex`, () => {
      const src = read(view);
      expect(src).toMatch(/pageRobots:\s*["']noindex/);
    });
  }

  it("the admin dashboard head still carries a hardcoded noindex", () => {
    // The dashboard is no longer Disallow-ed, so this tag is now the only
    // thing keeping it out of the index.
    expect(read("views/admin/_head.ejs")).toMatch(
      /<meta\s+name="robots"\s+content="noindex/
    );
  });

  it("the shared header honours pageRobots and defaults to indexable", () => {
    const header = read("views/modules/header.ejs");
    expect(header).toContain("pageRobots");
    expect(header).toMatch(/index,\s*follow/);
  });
});
