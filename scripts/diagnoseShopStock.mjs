/*
 * Read-only diagnostic for the Shop Directory "Stock unknown" state. Makes NO
 * changes.
 *
 * Run this on the server (where the real QUICKSHOP_URL is set), e.g.:
 *   node scripts/diagnoseShopStock.mjs            # whole-directory breakdown
 *   node scripts/diagnoseShopStock.mjs wool       # plus a per-shop listing for "wool"
 *
 * Background: the website reads stock from QuickShop's qs_external_cache. A
 * value of -1 there means QuickShop has NOT counted that shop recently, which
 * the directory shows as "Stock unknown" (not "empty"). This script quantifies
 * how many shops are in each state so we can tell whether QuickShop is simply
 * failing to refresh its cache.
 */
import dotenv from "dotenv";
dotenv.config();

import { quickshopDb } from "../controllers/databaseController.js";

const term = process.argv[2] || null;
const likeTerm = term ? `%${term.toLowerCase()}%` : null;

function query(label, sql, params = []) {
  return new Promise((resolve) => {
    quickshopDb.query(sql, params, (err, rows) => {
      if (err) {
        console.log(`${label}\n    ERROR: ${err.message}`);
      } else {
        console.log(`${label} ${JSON.stringify(rows)}`);
      }
      resolve();
    });
  });
}

const main = async () => {
  console.log(`\n=== Shop stock diagnostic${term ? ` (term "${term}")` : ""} ===\n`);

  console.log("-- Raw qs_external_cache (every cached row, orphans included) --");
  await query("cache stock breakdown:",
    `SELECT
       SUM(stock = -1) AS unknown_minus1,
       SUM(stock < 0)  AS unknown_any_negative,
       SUM(stock = 0)  AS out_of_stock,
       SUM(stock > 0)  AS counted_in_stock,
       COUNT(*)        AS total_rows
     FROM qs_external_cache`);

  console.log("\n-- Cache health vs live shops --");
  await query("live shops:", "SELECT COUNT(*) c FROM qs_shops");
  await query("live shops WITHOUT a cache row (invisible in directory):",
    `SELECT COUNT(*) c
       FROM qs_shops s
       LEFT JOIN qs_external_cache x ON s.id = x.shop
      WHERE x.shop IS NULL`);
  await query("orphan cache rows (cache row, no live shop):",
    `SELECT COUNT(*) c
       FROM qs_external_cache x
       LEFT JOIN qs_shops s ON s.id = x.shop
      WHERE s.id IS NULL`);

  console.log("\n-- As the directory shows it (selling shops only, exactly the display filter) --");
  // data.type: 0 = SELLING, 1 = BUYING. Buying shops show "Buying", never
  // "unknown", so the unknown problem only concerns selling shops.
  await query("displayed selling-shop stock breakdown:",
    `SELECT
       SUM(x.stock < 0)  AS stock_unknown,
       SUM(x.stock = 0)  AS out_of_stock,
       SUM(x.stock > 0)  AS in_stock,
       COUNT(*)          AS total_selling
     FROM qs_shops s
     JOIN qs_shop_map map ON s.id = map.shop
     JOIN qs_data data    ON s.data = data.id
     JOIN qs_external_cache x ON s.id = x.shop
    WHERE data.unlimited = 0 AND data.type = 0`);

  console.log("\n-- A few example 'unknown' selling shops --");
  await query("sample unknown-stock shops:",
    `SELECT
       s.id AS shop_id,
       s.owner,
       JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) AS item,
       x.stock, x.space,
       map.world, map.x, map.y, map.z
     FROM qs_shops s
     JOIN qs_shop_map map ON s.id = map.shop
     JOIN qs_data data    ON s.data = data.id
     JOIN qs_external_cache x ON s.id = x.shop
    WHERE data.unlimited = 0 AND data.type = 0 AND x.stock < 0
    ORDER BY s.id DESC
    LIMIT 10`);

  if (likeTerm) {
    console.log(`\n-- Per-shop listing for "${term}" (selling shops) --`);
    await query(`shops matching "${term}":`,
      `SELECT
         s.id AS shop_id,
         s.owner,
         JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) AS item,
         data.price,
         x.stock, x.space,
         map.world, map.x, map.y, map.z
       FROM qs_shops s
       JOIN qs_shop_map map ON s.id = map.shop
       JOIN qs_data data    ON s.data = data.id
       JOIN qs_external_cache x ON s.id = x.shop
      WHERE data.unlimited = 0 AND data.type = 0
        AND (
          LOWER(CONVERT(JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) USING utf8mb4)) LIKE ?
          OR LOWER(CONVERT(JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.tags')) USING utf8mb4)) LIKE ?
        )
      ORDER BY item, s.id`,
      [likeTerm, likeTerm]);
  }

  console.log("");
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => quickshopDb.end?.(() => {}));
