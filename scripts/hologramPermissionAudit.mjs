/**
 * scripts/hologramPermissionAudit.mjs
 *
 * One-off audit for the holograms -> announcements merge (migration 0081).
 *
 * `zander.web.holograms` has been removed; everything is now gated by
 * `zander.web.announcements`. This script reports every LuckPerms group that
 * grants `zander.web.holograms` (directly, through a wildcard, or by inheritance)
 * but does NOT grant `zander.web.announcements`, so those ranks can be fixed
 * before the old node disappears. It only reads; it changes nothing.
 *
 * Run: node scripts/hologramPermissionAudit.mjs
 */
import { luckpermsDb } from "../controllers/databaseController.js";
import { findGrantingGroups } from "../lib/permissions/permissionHolders.mjs";

const ACTIVE = "value = 1 AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())";

function lp(query, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(query, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

async function main() {
  const groupPermissions = await lp(`SELECT name, permission FROM luckperms_group_permissions WHERE ${ACTIVE}`);
  const holders = findGrantingGroups("zander.web.holograms", groupPermissions);
  const announcers = findGrantingGroups("zander.web.announcements", groupPermissions);

  const needFix = [...holders].filter((g) => !announcers.has(g)).sort();

  console.log(`Groups granting zander.web.holograms: ${[...holders].sort().join(", ") || "(none)"}`);
  console.log(`Groups granting zander.web.announcements: ${[...announcers].sort().join(", ") || "(none)"}`);
  console.log("");
  if (needFix.length === 0) {
    console.log("OK: every rank with holograms access also has announcements access. Nothing to fix.");
  } else {
    console.log("ACTION NEEDED: these ranks hold zander.web.holograms WITHOUT zander.web.announcements:");
    for (const g of needFix) console.log(`  - ${g}`);
    console.log("");
    console.log("Grant zander.web.announcements to each, or they lose hologram access after this release.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit failed:", err?.message || err);
    process.exit(1);
  });
