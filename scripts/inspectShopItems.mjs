/*
 * Read-only diagnostic: shows what the shop directory sees for new-format
 * (QuickShop-Hikari NBT) shop items — the indexed JSON in qs_data.name, the
 * raw decoded NBT tree, and what decodeShopItem() extracts from it.
 * Makes no changes to any database.
 *
 * Usage:
 *   node scripts/inspectShopItems.mjs [search] [limit]
 *   node scripts/inspectShopItems.mjs enchanted_book 3
 *   node scripts/inspectShopItems.mjs diamond_sword
 */
import dotenv from "dotenv";
dotenv.config();

import zlib from "zlib";
import { quickshopDb } from "../controllers/databaseController.js";
import { parseNbt, decodeShopItem } from "../lib/quickshopNbt.js";

const search = process.argv[2] || "enchanted_book";
const limit = Math.min(parseInt(process.argv[3]) || 3, 20);

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    quickshopDb.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results || []);
    });
  });
}

const replacer = (_key, value) => (typeof value === "bigint" ? `${value}L` : value);

const main = async () => {
  const rows = await query(
    `SELECT id, name, item FROM qs_data
     WHERE item NOT LIKE 'item:%' AND CAST(name AS CHAR) LIKE ?
     ORDER BY id DESC LIMIT ?`,
    [`%${search}%`, limit]
  );

  if (!rows.length) {
    console.log(`No new-format qs_data rows with "${search}" in name.`);
    return;
  }

  for (const row of rows) {
    console.log(`\n=== qs_data.id ${row.id} ===`);
    console.log("indexed name:", typeof row.name === "object" ? JSON.stringify(row.name) : row.name);
    try {
      const tree = parseNbt(zlib.gunzipSync(Buffer.from(row.item, "base64")));
      console.log("NBT tree:", JSON.stringify(tree, replacer, 2));
    } catch (err) {
      console.log("NBT decode failed:", err.message);
    }
    console.log("decodeShopItem:", JSON.stringify(decodeShopItem(row.item)));
  }
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => quickshopDb.end?.(() => {}));
