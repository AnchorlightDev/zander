import { luckpermsDb } from "../controllers/databaseController.js";

function queryLuckPerms(sql, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => {
      if (error) reject(error);
      else resolve(results);
    });
  });
}

async function main() {
  const isApply = process.argv.includes("--apply");

  const whereClause = `
    contexts = '[]'
    AND (
      permission LIKE 'group.%'
      OR permission LIKE 'meta.group.%.title.%'
    )
  `;

  const [summary] = await queryLuckPerms(
    `SELECT
        COUNT(*) AS brokenRowCount,
        COUNT(DISTINCT uuid) AS affectedUserCount
       FROM luckperms_user_permissions
      WHERE ${whereClause}`
  );

  const brokenRowCount = Number(summary?.brokenRowCount || 0);
  const affectedUserCount = Number(summary?.affectedUserCount || 0);

  console.log(`[repair-luckperms-contexts] Broken rows: ${brokenRowCount}`);
  console.log(`[repair-luckperms-contexts] Affected users: ${affectedUserCount}`);

  if (!isApply) {
    console.log("[repair-luckperms-contexts] Dry run only. Re-run with --apply to update rows.");
    return;
  }

  if (brokenRowCount === 0) {
    console.log("[repair-luckperms-contexts] Nothing to repair.");
    return;
  }

  const result = await queryLuckPerms(
    `UPDATE luckperms_user_permissions
        SET contexts = '{}'
      WHERE ${whereClause}`
  );

  console.log(`[repair-luckperms-contexts] Updated rows: ${Number(result?.affectedRows || 0)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[repair-luckperms-contexts] Failed:", error);
    process.exit(1);
  });
