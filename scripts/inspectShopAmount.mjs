/*
 * Read-only diagnostic for the shop directory's "Amount" / "Price" columns.
 *
 * Shows, for every matching shop, exactly what services/shopService.js computes:
 *   - amount  (item stack count: parsed from YAML `count:` for old shops,
 *              or qs_data.name.$.count for new NBT shops)
 *   - price   (qs_data.price)
 * plus the raw head of qs_data.item and the indexed name, for both the
 * old (YAML) and new (base64+gzip NBT) QuickShop-Hikari storage formats.
 *
 * Makes NO changes to any database (SELECT only).
 *
 * Usage:
 *   node scripts/inspectShopAmount.mjs honey_block
 *   node scripts/inspectShopAmount.mjs honey_block 20
 */
import dotenv from "dotenv";
dotenv.config();

import { quickshopDb } from "../controllers/databaseController.js";

const search = (process.argv[2] || "honey_block").toLowerCase();
const limit = Math.min(parseInt(process.argv[3]) || 10, 50);

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    quickshopDb.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results || []);
    });
  });
}

const main = async () => {
  const like = `%${search}%`;
  const rows = await query(
    `SELECT
       shops.id,
       CASE WHEN data.item LIKE 'item:%' THEN 'OLD(yaml)' ELSE 'NEW(nbt)' END AS fmt,
       CASE
         WHEN data.item LIKE 'item:%' THEN
           REPLACE(TRIM(SUBSTRING_INDEX(SUBSTR(data.item, LOCATE('id:', data.item) + 3), '\n', 1)), 'minecraft:', '')
         ELSE JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id'))
       END AS item,
       CASE
         WHEN data.item NOT LIKE 'item:%' THEN JSON_EXTRACT(data.name, '$.count')
         WHEN LOCATE('count:', data.item) = 0 THEN NULL
         ELSE TRIM(SUBSTRING_INDEX(SUBSTR(data.item, LOCATE('count:', data.item) + 6), '\n', 1))
       END AS amount,
       data.price,
       data.type AS shop_type,
       data.name AS indexed_name,
       LEFT(data.item, 400) AS item_head
     FROM qs_shops shops
     JOIN qs_data data ON shops.data = data.id
     WHERE data.unlimited = 0
       AND (
         (data.item LIKE 'item:%' AND LOWER(CONVERT(data.item USING utf8mb4)) LIKE ?)
         OR (data.item NOT LIKE 'item:%'
             AND LOWER(CONVERT(JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) USING utf8mb4)) LIKE ?)
       )
     ORDER BY shops.id DESC
     LIMIT ?`,
    [like, like, limit]
  );

  if (!rows.length) {
    console.log(`No shops found matching "${search}".`);
    return;
  }

  for (const r of rows) {
    const t = Number(r.shop_type) === 1 ? "buying" : "selling";
    console.log(`\n--- shop ${r.id}  [${r.fmt}]  (${t}) ---`);
    console.log(`  item=${r.item}   amount=${JSON.stringify(r.amount)}   price=${r.price}`);
    console.log(`  indexed_name=${typeof r.indexed_name === "object" ? JSON.stringify(r.indexed_name) : r.indexed_name}`);
    console.log(`  item_head=${String(r.item_head).replace(/\n/g, "\\n")}`);
  }
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => quickshopDb.end?.(() => {}));
