/*
 * Prints the web permission tables for the docs site's permissions page
 * (https://anchorlight.dev/docs/products/zander/permissions), generated from
 * lib/permissions/zanderNodes.mjs so the published reference matches the
 * ranks dashboard checklist. Read-only; prints to stdout.
 *
 * Usage:
 *   node scripts/permissionsTable.mjs > permissions-tables.md
 */
import { pathToFileURL } from "url";
import { PERMISSION_GROUPS } from "../lib/permissions/zanderNodes.mjs";

// Backslashes first, or a "\|" in the text would end up as an escaped
// backslash followed by a live column separator.
const escapeCell = (text) =>
  String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderPermissionTables() {
  return PERMISSION_GROUPS.map((group) => {
    const rows = group.nodes.map((entry) => `| \`${entry.node}\` | ${escapeCell(entry.description)} |`);
    return [`## ${group.group}`, "", "| Permission Node | Description |", "|---|---|", ...rows].join("\n");
  }).join("\n\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(renderPermissionTables());
}
