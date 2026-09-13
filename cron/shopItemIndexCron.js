import cron from "node-cron";
import zlib from "zlib";
import { quickshopDb } from "../controllers/databaseController.js";

// Decode a base64+gzip NBT binary (QuickShop-Hikari new format, ~2026-04-22, id ≥ 6000)
// and extract the item ID and count.  Returns { id, count } or null on failure.
// NBT layout we rely on:
//   TAG_String (0x08) key="id"    → item ID string e.g. "minecraft:diamond"
//   TAG_Int    (0x03) key="count" → stack size as big-endian int32
function decodeNbtItemData(rawItem) {
  try {
    const buf = Buffer.from(rawItem, "base64");
    const nbt = zlib.gunzipSync(buf);

    // TAG_String = 0x08 | 2-byte key len | key bytes | 2-byte value len | value bytes
    const idPattern = Buffer.from([0x08, 0x00, 0x02, 0x69, 0x64]); // \x08\x00\x02id
    const idIdx = nbt.indexOf(idPattern);
    if (idIdx === -1) return null;
    const idLen = nbt.readUInt16BE(idIdx + 5);
    const rawId = nbt.toString("utf8", idIdx + 7, idIdx + 7 + idLen);
    const itemId = rawId.replace("minecraft:", "");

    // TAG_Int = 0x03 | 2-byte key len | key bytes | 4-byte big-endian int32
    const countPattern = Buffer.from([0x03, 0x00, 0x05, 0x63, 0x6f, 0x75, 0x6e, 0x74]); // \x03\x00\x05count
    const countIdx = nbt.indexOf(countPattern);
    const count = countIdx !== -1 ? nbt.readInt32BE(countIdx + 8) : 1;

    return { id: itemId, count };
  } catch (err) {
    return null;
  }
}

function queryAsync(sql, params) {
  return new Promise((resolve, reject) => {
    quickshopDb.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function indexNewShopItems() {
  // Pick up rows that are new-format AND either not yet indexed (name IS NULL)
  // or previously indexed with the old plain-ID format (name NOT LIKE '{%').
  const rows = await queryAsync(
    `SELECT id, item FROM qs_data
     WHERE item NOT LIKE 'item:%'
       AND (name IS NULL OR name NOT LIKE '{%')
     LIMIT 500`,
    []
  );

  if (!rows || rows.length === 0) return 0;

  const updates = rows.map((row) => {
    const data = decodeNbtItemData(row.item);
    // On decode failure store '{}' so we don't keep retrying this row
    const nameValue = data ? JSON.stringify({ id: data.id, count: data.count }) : "{}";
    return queryAsync(`UPDATE qs_data SET name = ? WHERE id = ?`, [nameValue, row.id])
      .then(() => (data ? 1 : 0))
      .catch((err) => {
        console.error(`Shop index update error for data id=${row.id}:`, err);
        return 0;
      });
  });

  const results = await Promise.all(updates);
  return results.reduce((sum, n) => sum + n, 0);
}

async function runIndex(label) {
  try {
    await indexNewShopItems();
  } catch (err) {
    console.error("Shop item index error:", err);
  }
}

// Run on startup to backfill existing unindexed rows
runIndex("backfilled");

// Run every 5 minutes to pick up newly created shops
cron.schedule("*/5 * * * *", () => {
  runIndex("indexed");
});
