/**
 * admin/migrate-views.mjs
 *
 * One-shot migration script: converts remaining legacy dashboard EJS views
 * from the old 3-col Bootstrap grid layout to the new WordPress-style admin
 * layout.
 *
 * Run once:  node admin/migrate-views.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, "..");

// ── Files to migrate ────────────────────────────────────────────────────────
// Each entry: [path relative to ROOT, depth, page heading label, activeSlug]
const FILES = [
  // Depth 1 (views/dashboard/*.ejs)
  [
    "views/dashboard/logs.ejs",
    1,
    "Logs",
    "logs",
  ],
  [
    "views/dashboard/bridge.ejs",
    1,
    "Bridge",
    "bridge",
  ],
  [
    "views/dashboard/web-punishments.ejs",
    1,
    "Web Punishments",
    "web-punishments",
  ],

  // Depth 2 (views/dashboard/[sub]/*.ejs)
  [
    "views/dashboard/announcements/announcements-editor.ejs",
    2,
    null, // Keep existing header inside the file
    "announcements",
  ],
  [
    "views/dashboard/applications/application-list.ejs",
    2,
    "Applications",
    "applications",
  ],
  [
    "views/dashboard/applications/application-editor.ejs",
    2,
    null,
    "applications",
  ],
  [
    "views/dashboard/forums/categories.ejs",
    2,
    "Forum Categories",
    "forums",
  ],
  [
    "views/dashboard/ranks/index.ejs",
    2,
    "Ranks",
    "ranks",
  ],
  [
    "views/dashboard/scheduler/scheduler-index.ejs",
    2,
    "Scheduler",
    "scheduler",
  ],
  [
    "views/dashboard/servers/server-editor.ejs",
    2,
    null,
    "servers",
  ],
  [
    "views/dashboard/vault/vault-list.ejs",
    2,
    "Vault",
    "vault",
  ],
  [
    "views/dashboard/vault/vault-editor.ejs",
    2,
    null,
    "vault",
  ],
  [
    "views/dashboard/voting/sites.ejs",
    2,
    "Vote Sites",
    "voting-sites",
  ],
  [
    "views/dashboard/voting/rewards.ejs",
    2,
    "Reward Templates",
    "voting-rewards",
  ],
  [
    "views/dashboard/voting/leaderboard.ejs",
    2,
    "Leaderboard",
    "voting-leaderboard",
  ],
  [
    "views/dashboard/voting/queue.ejs",
    2,
    "Reward Queue",
    "voting-queue",
  ],
  [
    "views/dashboard/events/events-calendar.ejs",
    2,
    "Events Calendar",
    "events-calendar",
  ],
  [
    "views/dashboard/events/events-list.ejs",
    2,
    "All Events",
    "events-list",
  ],
  [
    "views/dashboard/events/events-review.ejs",
    2,
    "Review Queue",
    "events-review",
  ],
  [
    "views/dashboard/events/events-templates.ejs",
    2,
    "Event Templates",
    "events-templates",
  ],
  [
    "views/dashboard/events/events-template-editor.ejs",
    2,
    null,
    "events-templates",
  ],
  [
    "views/dashboard/events/events-editor.ejs",
    2,
    null,
    "events-list",
  ],
  [
    "views/dashboard/events/events-view.ejs",
    2,
    null,
    "events-list",
  ],
];

// ── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Build the regex that matches the entire legacy header block.
 * Works for both depth-1 (../) and depth-2 (../../) paths.
 */
function buildHeaderRegex() {
  // Matches from the opening <%- include("*/modules/header.ejs" ...
  // down to the closing <main class="col-lg-*">  (allowing any class combo)
  return /<%- include\(["']\.\.[./]*modules\/header\.ejs["'],[\s\S]*?%>\s*\n[\s\S]*?<main[^>]*>/m;
}

/**
 * Build the regex that matches the legacy footer block:
 *   </main>\n    </div>\n</div>\n\n<%- include(".../modules/footer.ejs") %>
 */
function buildFooterRegex() {
  return /[ \t]*<\/main>\s*\n[ \t]*<\/div>\s*\n<\/div>\s*\n+<%- include\(["']\.\.[./]*modules\/footer\.ejs["']\) %>/m;
}

// ── Replacement builders ─────────────────────────────────────────────────────

function newHeader(depth) {
  const prefix = depth === 1 ? "../" : "../../";
  return `<%- include("${prefix}admin/_head.ejs", { pageTitle }) %>
<%- include("${prefix}admin/_topbar.ejs") %>
<%- include("${prefix}admin/_sidebar.ejs") %>

<div id="wpcontent">
  <div id="wpbody-content">
    <div class="wrap">`;
}

function newFooter(depth) {
  const prefix = depth === 1 ? "../" : "../../";
  return `    </div><!-- /.wrap -->
  </div><!-- /#wpbody-content -->
  <%- include("${prefix}admin/_footer.ejs") %>
</div><!-- /#wpcontent -->`;
}

// ── Alert-include replacement ────────────────────────────────────────────────
// The old views use: <%- include("*/partials/alert.ejs", { alertType, content }) %>
// wrapped in: <% if (req.cookies.alertType) { %> ... <% } %>
// The new _notices.ejs already handles cookie-based alerts, so we replace
// the entire block with a single notices include.

function alertBlockPattern(depth) {
  const prefix = depth === 1 ? "../" : "../../";
  // The block is optional – only present in some files.
  return new RegExp(
    `\\s*<% if \\(req\\.cookies\\.alertType\\) \\{[\\s\\S]*?%>\\s*\\n?\\s*<%- include\\(["']${prefix.replace(/\//g, "\\/")}partials\\/alert\\.ejs["'],[\\s\\S]*?%>\\s*\\n?\\s*<% \\} %>`,
    "m"
  );
}

function alertReplacement(depth) {
  const prefix = depth === 1 ? "../" : "../../";
  return `\n      <%- include("${prefix}admin/_notices.ejs") %>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

let migrated = 0;
let skipped  = 0;

for (const [relPath, depth, _heading, _slug] of FILES) {
  const fullPath = resolve(ROOT, relPath);

  let source;
  try {
    source = readFileSync(fullPath, "utf8");
  } catch (e) {
    console.warn(`  SKIP  ${relPath}  (not found)`);
    skipped++;
    continue;
  }

  // Skip if already migrated
  if (source.includes("admin/_head.ejs")) {
    console.log(`  OK    ${relPath}  (already migrated)`);
    skipped++;
    continue;
  }

  const headerRx = buildHeaderRegex();
  const footerRx = buildFooterRegex();

  let updated = source;

  // Replace header block
  if (headerRx.test(updated)) {
    updated = updated.replace(headerRx, newHeader(depth));
  } else {
    console.warn(`  WARN  ${relPath}  — header pattern not matched; skipping header`);
  }

  // Replace footer block
  if (footerRx.test(updated)) {
    updated = updated.replace(footerRx, newFooter(depth));
  } else {
    console.warn(`  WARN  ${relPath}  — footer pattern not matched; skipping footer`);
  }

  // Replace alert include blocks (optional; best-effort)
  const alertRx = alertBlockPattern(depth);
  if (alertRx.test(updated)) {
    updated = updated.replace(alertRx, alertReplacement(depth));
  }

  if (updated === source) {
    console.log(`  ----  ${relPath}  (no changes detected)`);
    skipped++;
    continue;
  }

  writeFileSync(fullPath, updated, "utf8");
  console.log(`  DONE  ${relPath}`);
  migrated++;
}

console.log(`\nMigration complete: ${migrated} updated, ${skipped} skipped.`);
