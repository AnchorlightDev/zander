/**
 * admin/fix-footers.mjs
 *
 * Second-pass fix for dashboard views where the migration script could not
 * replace the footer because modal/script content appeared between the
 * </main> close and the footer.ejs include.
 *
 * Run once:  node admin/fix-footers.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, "..");

const FILES = [
  // [relPath, depth]
  ["views/dashboard/bridge.ejs",                   1],
  ["views/dashboard/voting/sites.ejs",             2],
  ["views/dashboard/voting/rewards.ejs",           2],
  ["views/dashboard/events/events-review.ejs",     2],
  ["views/dashboard/events/events-editor.ejs",     2],
  ["views/dashboard/events/events-view.ejs",       2],
  ["views/dashboard/ranks/index.ejs",              2],
  ["views/dashboard/scheduler/scheduler-index.ejs",2],
];

for (const [relPath, depth] of FILES) {
  const fullPath = resolve(ROOT, relPath);
  let src;
  try {
    src = readFileSync(fullPath, "utf8");
  } catch (e) {
    console.warn(`SKIP  ${relPath} (not found)`);
    continue;
  }

  const oldFooterInclude = depth === 1
    ? `<%- include("../modules/footer.ejs") %>`
    : `<%- include("../../modules/footer.ejs") %>`;

  const adminPrefix = depth === 1 ? "../" : "../../";

  const newFooter = `    </div><!-- /.wrap -->
  </div><!-- /#wpbody-content -->
  <%- include("${adminPrefix}admin/_footer.ejs") %>
</div><!-- /#wpcontent -->`;

  // Remove the stray </main> + grid closing divs left by the first script.
  // They appear as:   </main>\n  </div>\n</div>  (possibly with varying indent)
  // Use a forgiving regex.
  const gridCloseRx = /[ \t]*<\/main>[ \t]*\n[ \t]*<\/div>[ \t]*\n<\/div>/m;

  let updated = src;

  if (gridCloseRx.test(updated)) {
    updated = updated.replace(gridCloseRx, "");
    console.log(`  cleaned grid close — ${relPath}`);
  }

  if (updated.includes(oldFooterInclude)) {
    updated = updated.replace(oldFooterInclude, newFooter);
    console.log(`  fixed footer       — ${relPath}`);
    writeFileSync(fullPath, updated, "utf8");
  } else if (!updated.includes("admin/_footer.ejs")) {
    console.warn(`  WARN no footer found in ${relPath}`);
  } else {
    console.log(`  already fixed      — ${relPath}`);
  }
}

console.log("\nFix-footers complete.");
