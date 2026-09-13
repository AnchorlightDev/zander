/**
 * admin/migrate-support-views.mjs
 *
 * Bridge the support dashboard views (in views/modules/dashboard/support/)
 * to the new admin layout.  These live 3 levels deep so paths differ.
 *
 * Run once:  node admin/migrate-support-views.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, "..");

// Files in views/modules/dashboard/support/
const FILES = [
  "views/modules/dashboard/support/index.ejs",
  "views/modules/dashboard/support/explorer.ejs",
  "views/modules/dashboard/support/categories.ejs",
  "views/modules/dashboard/support/edit-category.ejs",
];

// These files are 3 directories deep from views/
// → to reach views/admin/ we need ../../../admin/

const DEPTH_3_HEADER_RX = /<%- include\(["']\.\.\/(\.\.\/)?\.\.\/modules\/header\.ejs["'],[\s\S]*?%>\s*\n[\s\S]*?<main[^>]*>/m;

const GRID_CLOSE_RX = /[ \t]*<\/main>[ \t]*\n[ \t]*<\/div>[ \t]*\n[ \t]*<\/div>/m;

const OLD_FOOTER = `<%- include('../../../modules/footer.ejs') %>`;
const OLD_FOOTER_ALT = `<%- include("../../../modules/footer.ejs") %>`;

const NEW_HEADER = `<%- include("../../../admin/_head.ejs", { pageTitle }) %>
<%- include("../../../admin/_topbar.ejs") %>
<%- include("../../../admin/_sidebar.ejs") %>

<div id="wpcontent">
  <div id="wpbody-content">
    <div class="wrap">`;

const NEW_FOOTER = `    </div><!-- /.wrap -->
  </div><!-- /#wpbody-content -->
  <%- include("../../../admin/_footer.ejs") %>
</div><!-- /#wpcontent -->`;

for (const relPath of FILES) {
  const fullPath = resolve(ROOT, relPath);
  let src;
  try {
    src = readFileSync(fullPath, "utf8");
  } catch (e) {
    console.warn(`SKIP ${relPath} (not found)`);
    continue;
  }

  if (src.includes("admin/_head.ejs")) {
    console.log(`OK   ${relPath} (already migrated)`);
    continue;
  }

  let updated = src;

  // Replace header block
  if (DEPTH_3_HEADER_RX.test(updated)) {
    updated = updated.replace(DEPTH_3_HEADER_RX, NEW_HEADER);
  } else {
    // Try a simpler header pattern (some files may have different structure)
    const simpleHdr = /<%- include\(['"]\.\.\/\.\.\/\.\.\/modules\/header\.ejs['"]/;
    if (simpleHdr.test(updated)) {
      // Replace everything from the first include to the main tag
      const start = updated.indexOf("<%- include('../../../modules");
      if (start === -1) {
        console.warn(`WARN ${relPath} — cannot find header start`);
      } else {
        const mainIdx = updated.indexOf("<main", start);
        if (mainIdx !== -1) {
          const afterMain = updated.indexOf(">", mainIdx) + 1;
          updated = NEW_HEADER + "\n" + updated.slice(afterMain);
        }
      }
    } else {
      console.warn(`WARN ${relPath} — header pattern not found`);
    }
  }

  // Remove stray grid close tags
  if (GRID_CLOSE_RX.test(updated)) {
    updated = updated.replace(GRID_CLOSE_RX, "");
  }

  // Replace footer
  if (updated.includes(OLD_FOOTER)) {
    updated = updated.replace(OLD_FOOTER, NEW_FOOTER);
  } else if (updated.includes(OLD_FOOTER_ALT)) {
    updated = updated.replace(OLD_FOOTER_ALT, NEW_FOOTER);
  } else {
    console.warn(`WARN ${relPath} — footer pattern not found`);
  }

  // Replace alert cookie blocks
  const alertRx = /\s*<% if \(req\.cookies\.alertType\) \{[\s\S]*?%>\s*\n?\s*<%- include\(['"]\.\.\/\.\.\/\.\.\/partials\/alert\.ejs['"],[\s\S]*?%>\s*\n?\s*<% \} %>/m;
  if (alertRx.test(updated)) {
    updated = updated.replace(alertRx, `\n      <%- include("../../../admin/_notices.ejs") %>`);
  }

  if (updated !== src) {
    writeFileSync(fullPath, updated, "utf8");
    console.log(`DONE ${relPath}`);
  } else {
    console.log(`---- ${relPath} (no changes)`);
  }
}

console.log("\nSupport view migration complete.");
