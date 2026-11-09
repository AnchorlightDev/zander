import crypto from "crypto";
import db from "./databaseController.js";

/**
 * Data-access layer for Crafting For Christ Wrapped.
 *
 * Raw SQL via the mysql2 pool shim, matching the convention of the other
 * controllers in this repo. Two concerns live here:
 *   1. Zander's own per-user stats for a Wrapped period (gameSessions).
 *   2. Persistence of computed Wrapped payloads + the per-period leaderboard
 *      cache (see 0033_wrapped migration).
 *
 * All orchestration (calling MineMonitor, merging, ranking, deriving slides)
 * lives in services/wrapped/wrappedService.js.
 */

function q(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

export function generateShareId() {
  // URL-safe, 22 chars (~128 bits).
  return crypto.randomBytes(16).toString("base64url").slice(0, 22);
}

// ── Zander-side stats ──────────────────────────────────────────────────────

// Hard ceiling on a single session's counted time. A Minecraft session realistically
// never runs this long — anything longer is an unclosed/orphaned `sessionEnd IS NULL`
// row that would otherwise count from its start all the way to "now".
const SESSION_CAP_HOURS = 16;

/**
 * One derived row per session that overlaps the window:
 *   cs       = in-window seconds, clamped to [start, end] AND capped at
 *              SESSION_CAP_HOURS so orphaned rows can't inflate the total
 *   winStart = the session start clamped to the window start
 * Bind params (both call sites): [end, start, start, userId, end, start]
 */
const SESSION_SUBQUERY = `
  SELECT
    GREATEST(0, TIME_TO_SEC(TIMEDIFF(
      LEAST(COALESCE(sessionEnd, NOW()), sessionStart + INTERVAL ${SESSION_CAP_HOURS} HOUR, ?),
      GREATEST(sessionStart, ?)
    ))) AS cs,
    GREATEST(sessionStart, ?) AS winStart
  FROM gameSessions
  WHERE userId = ? AND sessionStart <= ? AND COALESCE(sessionEnd, NOW()) >= ?`;

/**
 * All playtime/session metrics for one user, **fully clamped to the Wrapped
 * window [start, end]** and capped per session:
 *   - session time truncated to the in-window overlap, then capped
 *   - only sessions that contributed real in-window time are counted
 *   - day / month buckets key off the clamped session start
 *   - "first seen" is the first counted activity within the window
 *   - tenure runs from that to the window end (or now, if earlier)
 */
export async function getZanderStatsForUser(userId, start, end) {
  const subParams = [end, start, start, userId, end, start];

  const [agg] = await q(
    `SELECT COALESCE(SUM(cs), 0) AS seconds,
            SUM(cs > 0)          AS sessions,
            MIN(CASE WHEN cs > 0 THEN winStart END) AS firstSeen
       FROM (${SESSION_SUBQUERY}) t`,
    subParams
  );

  const [dayRow] = await q(
    `SELECT DATE_FORMAT(winStart, '%Y-%m-%d') AS bucket, SUM(cs) AS seconds
       FROM (${SESSION_SUBQUERY}) t
      WHERE cs > 0
      GROUP BY bucket ORDER BY seconds DESC LIMIT 1`,
    subParams
  );

  const [monthRow] = await q(
    `SELECT DATE_FORMAT(winStart, '%Y-%m') AS bucket, SUM(cs) AS seconds
       FROM (${SESSION_SUBQUERY}) t
      WHERE cs > 0
      GROUP BY bucket ORDER BY seconds DESC LIMIT 1`,
    subParams
  );

  // Tenure / "been part of the server for …" is the player's *all-time* first
  // session — NOT their first session inside the Wrapped window (which is what
  // `agg.firstSeen` is, and why the rolling-12-month period made long-time
  // members read as "11 months").
  const [tenureRow] = await q(
    `SELECT MIN(sessionStart) AS firstSeen FROM gameSessions WHERE userId = ?`,
    [userId]
  );

  const seconds = Number(agg?.seconds) || 0;
  const sessions = Number(agg?.sessions) || 0;
  const firstSeen = tenureRow?.firstSeen || agg?.firstSeen || null;
  const tenureAnchor = Math.min(Date.now(), new Date(end).getTime());

  return {
    playtimeSeconds: seconds,
    sessions,
    avgSessionSeconds: sessions > 0 ? Math.round(seconds / sessions) : 0,
    firstSeen: firstSeen ? new Date(firstSeen).toISOString() : null,
    tenureDays: firstSeen
      ? Math.max(0, Math.floor((tenureAnchor - new Date(firstSeen).getTime()) / 86400000))
      : null,
    mostActiveDay: dayRow?.bucket
      ? { date: String(dayRow.bucket).slice(0, 10), seconds: Number(dayRow.seconds) || 0 }
      : null,
    mostActiveMonth: monthRow?.bucket
      ? { month: String(monthRow.bucket), seconds: Number(monthRow.seconds) || 0 }
      : null,
  };
}

/**
 * All users eligible for Wrapped ranking: a real (linked) Minecraft account,
 * not a placeholder, not disabled.
 */
export async function getLinkedUsers() {
  return q(
    `SELECT userId, username, uuid, discordId, profilePicture_type, profilePicture_email
       FROM users
      WHERE uuid IS NOT NULL AND uuid <> ''
        AND is_placeholder = 0
        AND account_disabled = 0`
  );
}

/**
 * One grouped query: period-scoped playtime seconds + session count for every
 * user. Feeds the leaderboard cache so per-user builds don't re-scan.
 * @returns {Promise<Map<number, { playtimeSeconds: number, sessions: number }>>}
 */
export async function getZanderLeaderboardRaw(start, end) {
  // Same clamp + per-session cap as getZanderStatsForUser, so ranks line up
  // exactly with what each user sees on their own deck.
  const rows = await q(
    `SELECT userId, COALESCE(SUM(cs), 0) AS seconds, SUM(cs > 0) AS sessions
       FROM (
         SELECT userId,
                GREATEST(0, TIME_TO_SEC(TIMEDIFF(
                  LEAST(COALESCE(sessionEnd, NOW()), sessionStart + INTERVAL ${SESSION_CAP_HOURS} HOUR, ?),
                  GREATEST(sessionStart, ?)
                ))) AS cs
           FROM gameSessions
          WHERE sessionStart <= ? AND COALESCE(sessionEnd, NOW()) >= ?
       ) t
      GROUP BY userId`,
    [end, start, end, start]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.userId), {
      playtimeSeconds: Number(r.seconds) || 0,
      sessions: Number(r.sessions) || 0,
    });
  }
  return map;
}

/** uuid / username / profile-picture preference for a user — for the Wrapped avatar. */
export async function getUserProfileRow(userId) {
  if (!userId) return null;
  const [row] = await q(
    `SELECT userId, uuid, username, profilePicture_type, profilePicture_email
       FROM users WHERE userId = ? LIMIT 1`,
    [userId]
  );
  return row || null;
}

// ── Persisted runs ────────────────────────────────────────────────────────

export async function getWrappedRun(userId, periodYear) {
  const [row] = await q(
    `SELECT * FROM wrappedRuns WHERE userId = ? AND periodYear = ? LIMIT 1`,
    [userId, periodYear]
  );
  return row ? hydrateRun(row) : null;
}

export async function getWrappedRunByShareId(shareId) {
  const [row] = await q(`SELECT * FROM wrappedRuns WHERE shareId = ? LIMIT 1`, [shareId]);
  return row ? hydrateRun(row) : null;
}

export async function upsertWrappedRun({ userId, periodYear, periodStart, periodEnd, shareId, payload, force = false }) {
  const json = JSON.stringify(payload);
  // First write wins — a generated run is immutable. `force` is the only path
  // that overwrites an existing payload (admin regenerate).
  const onDup = force
    ? `ON DUPLICATE KEY UPDATE periodStart = VALUES(periodStart), periodEnd = VALUES(periodEnd), payload = VALUES(payload)`
    : `ON DUPLICATE KEY UPDATE runId = runId`;
  await q(
    `INSERT INTO wrappedRuns (userId, periodYear, periodStart, periodEnd, shareId, payload)
       VALUES (?, ?, ?, ?, ?, ?)
     ${onDup}`,
    [userId, periodYear, periodStart, periodEnd, shareId, json]
  );
  return getWrappedRun(userId, periodYear);
}

export async function markWrappedViewed(userId, periodYear) {
  await q(
    `UPDATE wrappedRuns SET viewedAt = NOW()
      WHERE userId = ? AND periodYear = ? AND viewedAt IS NULL`,
    [userId, periodYear]
  );
}

/** Most recent runs for a period — for the admin dashboard listing. */
export async function listWrappedRuns(periodYear, limit = 25) {
  const rows = await q(
    `SELECT w.runId, w.userId, w.shareId, w.createdAt, w.viewedAt, u.username
       FROM wrappedRuns w
       LEFT JOIN users u ON u.userId = w.userId
      WHERE w.periodYear = ?
      ORDER BY w.createdAt DESC
      LIMIT ?`,
    [periodYear, Number(limit) || 25]
  );
  return rows.map((r) => ({
    runId: r.runId,
    userId: r.userId,
    username: r.username || `#${r.userId}`,
    shareId: r.shareId,
    createdAt: r.createdAt,
    viewedAt: r.viewedAt,
  }));
}

// ── Editable period settings (singleton row, id = 1) ──────────────────────

export async function getWrappedSettings() {
  const [row] = await q(
    `SELECT enabled, periodStart, periodEnd, rollingMonths FROM wrappedSettings WHERE id = 1`
  );
  return {
    enabled: row && row.enabled !== null ? Boolean(row.enabled) : null,
    periodStart: row?.periodStart ?? null,
    periodEnd: row?.periodEnd ?? null,
    rollingMonths: row?.rollingMonths != null ? Number(row.rollingMonths) : null,
  };
}

export async function saveWrappedSettings({ enabled, periodStart, periodEnd, rollingMonths }) {
  await q(
    `INSERT INTO wrappedSettings (id, enabled, periodStart, periodEnd, rollingMonths)
       VALUES (1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       periodStart = VALUES(periodStart),
       periodEnd = VALUES(periodEnd),
       rollingMonths = VALUES(rollingMonths)`,
    [
      enabled === null || enabled === undefined ? null : enabled ? 1 : 0,
      periodStart ?? null,
      periodEnd ?? null,
      rollingMonths == null ? null : Math.max(1, Math.min(24, Number(rollingMonths) || 12)),
    ]
  );
  return getWrappedSettings();
}

/** Has this user already generated (and thus been prompted for) this period? */
export async function hasWrappedRun(userId, periodYear) {
  const [row] = await q(
    `SELECT 1 AS x FROM wrappedRuns WHERE userId = ? AND periodYear = ? LIMIT 1`,
    [userId, periodYear]
  );
  return Boolean(row);
}

function hydrateRun(row) {
  return {
    runId: row.runId,
    userId: row.userId,
    periodYear: row.periodYear,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    shareId: row.shareId,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
    createdAt: row.createdAt,
    viewedAt: row.viewedAt,
  };
}

// ── Leaderboard cache ─────────────────────────────────────────────────────

export async function readLeaderboardCache(periodYear, maxAgeMs = 6 * 60 * 60 * 1000) {
  const [row] = await q(
    `SELECT computedAt, data FROM wrappedLeaderboardCache WHERE periodYear = ? LIMIT 1`,
    [periodYear]
  );
  if (!row) return null;
  const age = Date.now() - new Date(row.computedAt).getTime();
  if (age > maxAgeMs) return null;
  return {
    computedAt: row.computedAt,
    data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
  };
}

export async function writeLeaderboardCache(periodYear, data) {
  await q(
    `INSERT INTO wrappedLeaderboardCache (periodYear, data)
       VALUES (?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), computedAt = NOW()`,
    [periodYear, JSON.stringify(data)]
  );
}
