import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const viewsDir = join(repoRoot, "views");

function collectViews(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectViews(full));
    else if (entry.endsWith(".ejs")) out.push(full);
  }
  return out;
}

/**
 * Server-side secrets must never be interpolated into a template: EJS output
 * is delivered to the browser, so anything referenced here ends up readable in
 * page source by every viewer of that page.
 *
 * This previously happened with process.env.apiKey across the events dashboard,
 * which handed any staff member the app-wide token guarding every /api route.
 */
const FORBIDDEN = [
  { pattern: /process\.env\.apiKey/, label: "process.env.apiKey (app-wide API token)" },
  { pattern: /process\.env\.sessionCookieSecret/, label: "session cookie secret" },
  { pattern: /process\.env\.STRIPE_SECRET/i, label: "Stripe secret key" },
  { pattern: /process\.env\.\w*(PASSWORD|DATABASE_URL|_URL)\b/, label: "a connection string or password" },
  { pattern: /x-access-token/i, label: "an x-access-token header (implies a leaked API key)" },
];

describe("views contain no server-side secrets", () => {
  const views = collectViews(viewsDir);

  it("finds templates to scan", () => {
    expect(views.length).toBeGreaterThan(0);
  });

  for (const { pattern, label } of FORBIDDEN) {
    it(`no template references ${label}`, () => {
      const offenders = views
        .filter((file) => pattern.test(readFileSync(file, "utf8")))
        .map((file) => relative(repoRoot, file));

      expect(offenders).toEqual([]);
    });
  }
});
