import cron from "node-cron";
import { quickshopDb } from "../controllers/databaseController.js";
import { SHOP_INDEX_VERSION, decodeShopItem, buildIndexValue } from "../lib/quickshopNbt.js";

// QuickShop-Hikari stores new-format items (~2026-04-22, id ≥ 6000) as
// base64+gzip NBT, which SQL can't search. This cron decodes them and writes
// a JSON summary into qs_data.name — item ID, count, enchantments, potion,
// firework flight, shulker contents and a flat `tags` string — so the shop
// directory can search and label them. See lib/quickshopNbt.js.

const BATCH_SIZE = 500;
// Safety cap so a pathological table can't keep the startup backfill looping.
const MAX_BATCHES_PER_RUN = 200;

function queryAsync(sql, params) {
  return new Promise((resolve, reject) => {
    quickshopDb.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Rows that are new-format and not yet indexed at the current version: never
// indexed (NULL), indexed under the original plain-ID format, or indexed by an
// older version of this cron (no / different "v"). Matched as text so it works
// whether `name` is a VARCHAR or a JSON column (MySQL renders JSON as `"v": 2`).
const versionPattern = `"v": ?${SHOP_INDEX_VERSION}[,}]`;

async function indexBatch() {
  const rows = await queryAsync(
    `SELECT id, item FROM qs_data
     WHERE item NOT LIKE 'item:%'
       AND (name IS NULL OR CAST(name AS CHAR) NOT REGEXP ?)
     LIMIT ?`,
    [versionPattern, BATCH_SIZE]
  );

  if (!rows || rows.length === 0) return { scanned: 0, decoded: 0 };

  const results = await Promise.all(
    rows.map((row) => {
      const meta = decodeShopItem(row.item);
      // On decode failure we still stamp the version so the row isn't retried forever.
      return queryAsync(`UPDATE qs_data SET name = ? WHERE id = ?`, [buildIndexValue(meta), row.id])
        .then(() => (meta ? 1 : 0))
        .catch((err) => {
          console.error(`Shop index update error for data id=${row.id}:`, err);
          return 0;
        });
    })
  );

  return { scanned: rows.length, decoded: results.reduce((sum, n) => sum + n, 0) };
}

let running = false;

async function runIndex() {
  if (running) return;
  running = true;
  try {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const { scanned } = await indexBatch();
      if (scanned < BATCH_SIZE) break;
    }
  } catch (err) {
    console.error("Shop item index error:", err);
  } finally {
    running = false;
  }
}

// Run on startup to backfill (and re-index rows from older index versions)
runIndex();

// Run every 5 minutes to pick up newly created shops
cron.schedule("*/5 * * * *", () => {
  runIndex();
});
