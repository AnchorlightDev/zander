import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

vi.mock("../../controllers/apiClientController.js", () => ({
  getClientByPrefixCached: vi.fn(),
  touchLastUsed: vi.fn(),
}));

const { SESSION_ALLOWED_ROUTES } = await import("../../api/routes/verifyToken.js");

/**
 * Dashboard pages call the JSON API from the browser with the session cookie
 * and no x-access-token (templates must never carry one — see
 * tests/unit/noSecretsInViews.test.mjs). verifyToken only accepts a session on
 * routes listed in SESSION_ALLOWED_ROUTES; everything else fails closed with
 * "There was no token included in this request."
 *
 * When the app-wide shared key was retired, that map was populated by sweeping
 * the literal fetch("/api/...") URLs out of the views. Endpoints whose URL is
 * built from a variable were missed, so creating, editing and cancelling an
 * event, saving a template, and loading the calendar all broke in production.
 *
 * This test walks the dashboard templates and asserts every endpoint they can
 * reach is present in the map — including the ones behind a variable.
 */

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
 * Endpoints a dashboard template can call.
 *
 * Literal fetch URLs are found directly. Endpoints assembled from a variable
 * cannot be resolved statically, so any "/api/..." string anywhere in the
 * template is treated as reachable — that is deliberately over-inclusive,
 * because the cost of a missing entry is a broken page in production.
 */
function apiPathsIn(source) {
  const paths = new Set();
  for (const match of source.match(/["'`]\/api\/[a-zA-Z0-9/_-]+/g) || []) {
    paths.add(match.slice(1));
  }
  return paths;
}

/** Endpoints intentionally reachable without a session-map entry. */
const EXEMPT = new Set([
  // Registered outside the verifyToken plugin scope (app.js) — session-auth'd
  // in its own handler.
  "/api/upload/image",
  // Public, unauthenticated surfaces.
  "/api/events/upcoming",
  "/api/events/published",
  "/api/csp-report",
]);

const allowed = new Set([...SESSION_ALLOWED_ROUTES.keys()].map((k) => k.split(" ")[1]));

describe("dashboard templates can reach every API endpoint they call", () => {
  const views = collectViews(join(repoRoot, "views", "dashboard"));

  it("finds dashboard templates to scan", () => {
    expect(views.length).toBeGreaterThan(0);
  });

  it("every /api path referenced by a dashboard template is session-allowed", () => {
    const missing = [];

    for (const file of views) {
      for (const path of apiPathsIn(readFileSync(file, "utf8"))) {
        if (EXEMPT.has(path)) continue;
        if (!allowed.has(path)) {
          missing.push(`${relative(repoRoot, file)} -> ${path}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("every endpoint a dashboard route hands to a template is session-allowed", () => {
    /*
        The regression lived here, not in the templates.
        routes/dashboard/events.js passes apiEndpoint: "/api/events/create"
        into events-editor.ejs, which posts to it via a variable. Scanning only
        the .ejs files misses it entirely, so the route modules are scanned too.
    */
    const routeDir = join(repoRoot, "routes", "dashboard");
    const missing = [];

    for (const entry of readdirSync(routeDir)) {
      if (!entry.endsWith(".js")) continue;
      const file = join(routeDir, entry);
      const source = readFileSync(file, "utf8");

      // Endpoints handed to a view, e.g.  apiEndpoint: "/api/events/create"
      for (const match of source.match(/apiEndpoint:\s*[^,\n]+/g) || []) {
        for (const path of match.match(/["'`]\/api\/[a-zA-Z0-9/_-]+/g) || []) {
          const clean = path.slice(1);
          if (EXEMPT.has(clean) || allowed.has(clean)) continue;
          missing.push(`${relative(repoRoot, file)} -> ${clean}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("covers the endpoints that regressed, which are built from variables", () => {
    // These are reached via `apiEndpoint`, `endpoint` and eventAction(), so a
    // grep for literal fetch URLs does not find them.
    for (const path of [
      "/api/events/create",
      "/api/events/update",
      "/api/events/update-published",
      "/api/events/cancel",
      "/api/events/revert-to-draft",
      "/api/events/templates/create",
      "/api/events/templates/update",
      "/api/events/calendar",
    ]) {
      expect(allowed).toContain(path);
    }
  });
});

describe("session allowlist entries are well formed", () => {
  it("every key is 'METHOD /path'", () => {
    for (const key of SESSION_ALLOWED_ROUTES.keys()) {
      expect(key).toMatch(/^(GET|POST|PATCH|DELETE) \/[a-zA-Z0-9/_-]+$/);
    }
  });

  it("every entry carries at least one permission node", () => {
    // An empty list would mean "any logged-in session". No events route should
    // be that permissive — each one guards a staff action.
    const permissionless = [...SESSION_ALLOWED_ROUTES.entries()]
      .filter(([, nodes]) => !Array.isArray(nodes) || nodes.length === 0)
      .map(([key]) => key);

    expect(permissionless).toEqual([]);
  });

  it("keeps /api/events/cancel on a write node, since it has no check of its own", () => {
    // The handler performs no permission check, so this entry is the only gate.
    expect(SESSION_ALLOWED_ROUTES.get("POST /api/events/cancel")).toContain(
      "zander.web.events.edit"
    );
  });
});
