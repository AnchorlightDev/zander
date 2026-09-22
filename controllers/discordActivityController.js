/**
 * controllers/discordActivityController.js
 *
 * Reads and writes `discordActivityDaily` -- how many messages a Discord user
 * sent on a given date, and nothing else.
 *
 * This is a rollup, not a log. No message content and no per-message timestamp
 * is stored, which is both what keeps the write volume sane on a busy guild and
 * a deliberate privacy limit: the table answers "was this person around
 * regularly?" and cannot answer anything about what they said. Please do not
 * extend it into a message log.
 *
 * Raw mysql2 rather than Prisma Client, because the write is a multi-row
 * INSERT ... ON DUPLICATE KEY UPDATE -- an atomic increment that Prisma's
 * upsert cannot express without a round trip per row and a race between the
 * read and the write.
 */

import db from "./databaseController.js";

const query = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });

/** Local-date key ("2026-09-22") matching what the DATE column stores. */
export function activityDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Add message counts to the rollup.
 *
 * `counts` is a Map keyed "<discordUserId>|<YYYY-MM-DD>" holding how many
 * messages to add. One statement for the whole batch, so a flush is a single
 * round trip however many people were talking.
 */
export async function addMessageCounts(counts) {
  if (!counts || counts.size === 0) return 0;

  const rows = [];
  const params = [];

  for (const [key, count] of counts) {
    const separator = key.lastIndexOf("|");
    const discordUserId = key.slice(0, separator);
    const activityDate = key.slice(separator + 1);
    const amount = Number(count) || 0;
    if (!discordUserId || !activityDate || amount <= 0) continue;

    rows.push("(?, ?, ?)");
    params.push(discordUserId.slice(0, 24), activityDate, amount);
  }

  if (!rows.length) return 0;

  await query(
    `INSERT INTO discordActivityDaily (discordUserId, activityDate, messageCount)
     VALUES ${rows.join(", ")}
     ON DUPLICATE KEY UPDATE messageCount = messageCount + VALUES(messageCount)`,
    params
  );

  return rows.length;
}

/**
 * Activity for one user since a date.
 *
 * Returns { activeDays, messages }. `activeDays` is a plain COUNT(*) rather
 * than COUNT(DISTINCT activityDate) because the unique key on
 * (discordUserId, activityDate) already guarantees one row per day.
 */
export async function getDiscordActivitySince(discordUserId, since) {
  if (!discordUserId) return { activeDays: 0, messages: 0 };

  const rows = await query(
    `SELECT COUNT(*) AS activeDays, COALESCE(SUM(messageCount), 0) AS messages
     FROM discordActivityDaily
     WHERE discordUserId = ? AND activityDate >= ?`,
    [String(discordUserId), activityDateKey(new Date(since))]
  );

  return {
    activeDays: Number(rows?.[0]?.activeDays ?? 0) || 0,
    messages: Number(rows?.[0]?.messages ?? 0) || 0,
  };
}

// The earliest date in the table only ever moves backwards (it cannot, rows
// are only ever added for today) so once read it is stable for the life of the
// process. Worth caching: MIN() over a column that is not the leading part of
// any index is a full scan, and a gated form page would otherwise pay for it
// on every render.
let trackingStartCache;

/**
 * The date Discord activity tracking actually began, or null when the table is
 * empty.
 *
 * The requirements engine needs this to know when a 30-day Discord window is
 * still asking about time nobody was counting.
 */
export async function getDiscordTrackingStart() {
  if (trackingStartCache !== undefined) return trackingStartCache;

  try {
    const rows = await query("SELECT MIN(activityDate) AS firstDate FROM discordActivityDaily");
    const first = rows?.[0]?.firstDate ?? null;
    // An empty table is not cached: it means tracking has not started yet, and
    // the answer changes the moment the first message lands.
    if (!first) return null;
    trackingStartCache = new Date(first);
  } catch (error) {
    console.error("[discordActivity] Failed to read tracking start:", error.message);
    // Undefined rather than null, so a transient failure is retried rather
    // than cached as "no data".
    return null;
  }

  return trackingStartCache;
}

/** Test/maintenance hook: forget the cached tracking start. */
export function resetTrackingStartCache() {
  trackingStartCache = undefined;
}
