/*
 * Read-only diagnostic for the Shop Directory search. Makes NO changes.
 *
 * Run this on the server (where the real QUICKSHOP_URL is set), e.g.:
 *   node scripts/diagnoseShopSearch.mjs diamond
 *
 * It prints the row count at each stage of the search pipeline so we can see
 * exactly where results disappear: empty table, empty JOIN, missing index data
 * in qs_data.name, or the term genuinely matching nothing.
 */
import dotenv from "dotenv";
dotenv.config();

import { quickshopDb } from "../controllers/databaseController.js";

const term = process.argv[2] || "diamond";
const likeTerm = `%${term}%`;
const likeTermUnderscored = `%${term.toUpperCase().replace(/ /g, "_")}%`;

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
  console.log(`\n=== Shop search diagnostic for term "${term}" ===\n`);

  console.log("-- Table population --");
  await query("qs_data total:", "SELECT COUNT(*) c FROM qs_data");
  await query("qs_shops total:", "SELECT COUNT(*) c FROM qs_shops");
  await query("qs_shop_map total:", "SELECT COUNT(*) c FROM qs_shop_map");
  await query("qs_external_cache total:", "SELECT COUNT(*) c FROM qs_external_cache");

  console.log("\n-- Item format split --");
  await query("old-format (item LIKE 'item:%'):", "SELECT COUNT(*) c FROM qs_data WHERE item LIKE 'item:%'");
  await query("new-format (item NOT LIKE 'item:%'):", "SELECT COUNT(*) c FROM qs_data WHERE item NOT LIKE 'item:%'");
  await query("new-format with name index populated:",
    "SELECT COUNT(*) c FROM qs_data WHERE item NOT LIKE 'item:%' AND name IS NOT NULL AND JSON_VALID(CAST(name AS CHAR)) AND JSON_EXTRACT(name,'$.id') IS NOT NULL");
  await query("sample new-format names:",
    "SELECT id, CAST(name AS CHAR) name FROM qs_data WHERE item NOT LIKE 'item:%' AND name IS NOT NULL ORDER BY id DESC LIMIT 3");

  console.log("\n-- JOIN pipeline (no term filter) --");
  await query("shops+map:", "SELECT COUNT(*) c FROM qs_shops s JOIN qs_shop_map m ON s.id=m.shop");
  await query("shops+map+data:", "SELECT COUNT(*) c FROM qs_shops s JOIN qs_shop_map m ON s.id=m.shop JOIN qs_data d ON s.data=d.id");
  await query("+external_cache:", "SELECT COUNT(*) c FROM qs_shops s JOIN qs_shop_map m ON s.id=m.shop JOIN qs_data d ON s.data=d.id JOIN qs_external_cache x ON s.id=x.shop");
  await query("+unlimited=0:", "SELECT COUNT(*) c FROM qs_shops s JOIN qs_shop_map m ON s.id=m.shop JOIN qs_data d ON s.data=d.id JOIN qs_external_cache x ON s.id=x.shop WHERE d.unlimited=0");

  console.log("\n-- Term matches --");
  await query("old-format term match:",
    "SELECT COUNT(*) c FROM qs_data WHERE item LIKE 'item:%' AND (item LIKE ? OR item LIKE ?)",
    [likeTerm, likeTermUnderscored]);
  await query("new-format term match (name id/tags):",
    `SELECT COUNT(*) c FROM qs_data WHERE item NOT LIKE 'item:%' AND (
       JSON_UNQUOTE(JSON_EXTRACT(name,'$.id')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(name,'$.id')) LIKE ?
       OR JSON_UNQUOTE(JSON_EXTRACT(name,'$.tags')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(name,'$.tags')) LIKE ?)`,
    [likeTerm, likeTermUnderscored, likeTerm, likeTermUnderscored]);

  console.log("\n-- Full search COUNT (exactly as services/shopService.js) --");
  await query("TOTAL matches returned to the UI:",
    `SELECT COUNT(*) AS total
       FROM qs_shops shops
       JOIN qs_shop_map map ON shops.id = map.shop
       JOIN qs_data data ON shops.data = data.id
       JOIN qs_external_cache stock ON shops.id = stock.shop
       WHERE data.unlimited = 0
         AND (
           (data.item LIKE 'item:%' AND (data.item LIKE ? ESCAPE '\\\\' OR data.item LIKE ? ESCAPE '\\\\'))
           OR
           (data.item NOT LIKE 'item:%' AND (
             JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) LIKE ? ESCAPE '\\\\'
             OR JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.id')) LIKE ? ESCAPE '\\\\'
             OR JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.tags')) LIKE ? ESCAPE '\\\\'
             OR JSON_UNQUOTE(JSON_EXTRACT(data.name, '$.tags')) LIKE ? ESCAPE '\\\\'
           ))
         )`,
    [likeTerm, likeTermUnderscored, likeTerm, likeTermUnderscored, likeTerm, likeTermUnderscored]);

  console.log("");
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => quickshopDb.end?.(() => {}));
