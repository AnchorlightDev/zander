import db from "./databaseController.js";

const executeQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.query(query, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });

/**
 * Create a new punishment record (Discord or Web).
 * Dynamically builds the INSERT to remain compatible with databases
 * that have not yet applied the v1.10.0 migration (platform / actor_player_id columns).
 * @returns {Promise<number>} The inserted punishment ID.
 */
export async function createPunishment({
  type,
  platform,
  targetDiscordUserId,
  targetDiscordTag,
  targetPlayerId,
  actorDiscordUserId,
  actorPlayerId,
  actorNameSnapshot,
  reason,
  expiresAt,
  context,
  dmStatus,
}) {
  const columns = [
    "type",
    "target_discord_user_id",
    "target_discord_tag",
    "target_player_id",
    "actor_discord_user_id",
    "actor_name_snapshot",
    "reason",
    "expires_at",
    "context",
    "dm_status",
    "status",
  ];
  const values = [
    type,
    targetDiscordUserId || null,
    targetDiscordTag || null,
    targetPlayerId || null,
    actorDiscordUserId || null,
    actorNameSnapshot || null,
    reason,
    expiresAt || null,
    context ? JSON.stringify(context) : null,
    dmStatus || "NOT_APPLICABLE",
    "ACTIVE",
  ];

  // Only include new columns when explicitly provided so the query
  // works even if the migration hasn't been applied yet.
  if (platform !== undefined) {
    columns.push("platform");
    values.push(platform);
  }
  if (actorPlayerId !== undefined) {
    columns.push("actor_player_id");
    values.push(actorPlayerId);
  }

  const placeholders = columns.map(() => "?").join(", ");
  const result = await executeQuery(
    `INSERT INTO discord_punishments (${columns.join(", ")}) VALUES (${placeholders})`,
    values
  );
  return result.insertId;
}

/**
 * Get a punishment by ID.
 */
export async function getPunishmentById(id) {
  const rows = await executeQuery(
    `SELECT * FROM discord_punishments WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Get all active punishments for a Discord user.
 */
export async function getActivePunishments(targetDiscordUserId, type = null) {
  let query = `SELECT * FROM discord_punishments WHERE target_discord_user_id = ? AND status = 'ACTIVE'`;
  const params = [targetDiscordUserId];

  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }

  query += ` ORDER BY created_at DESC`;
  return executeQuery(query, params);
}

/**
 * Get punishment history for a Discord user.
 */
export async function getPunishmentHistory(targetDiscordUserId, limit = 50) {
  return executeQuery(
    `SELECT * FROM discord_punishments
     WHERE target_discord_user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [targetDiscordUserId, limit]
  );
}

/**
 * Get punishment history for a linked player ID.
 */
export async function getPunishmentsByPlayerId(playerId, limit = 50) {
  return executeQuery(
    `SELECT * FROM discord_punishments
     WHERE target_player_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [playerId, limit]
  );
}

/**
 * Lift a punishment (set status to LIFTED).
 */
export async function liftPunishment(id) {
  await executeQuery(
    `UPDATE discord_punishments SET status = 'LIFTED', lifted_at = NOW() WHERE id = ?`,
    [id]
  );
}

/**
 * Expire a punishment (set status to EXPIRED).
 */
export async function expirePunishment(id) {
  await executeQuery(
    `UPDATE discord_punishments SET status = 'EXPIRED', lifted_at = NOW() WHERE id = ?`,
    [id]
  );
}

/**
 * Find all active temporary punishments that have expired.
 */
export async function getExpiredActivePunishments() {
  return executeQuery(
    `SELECT * FROM discord_punishments
     WHERE status = 'ACTIVE'
       AND expires_at IS NOT NULL
       AND expires_at <= UTC_TIMESTAMP()`
  );
}

/**
 * Find all active punishments of a given type (for startup reconciliation).
 */
export async function getAllActivePunishments() {
  return executeQuery(
    `SELECT * FROM discord_punishments WHERE status = 'ACTIVE' ORDER BY created_at DESC`
  );
}

/**
 * Update the DM status of a punishment.
 */
export async function updateDmStatus(id, dmStatus) {
  await executeQuery(
    `UPDATE discord_punishments SET dm_status = ? WHERE id = ?`,
    [dmStatus, id]
  );
}

/**
 * Create a punishment appeal.
 * @returns {Promise<number>} The inserted appeal ID.
 */
export async function createAppeal({ punishmentId, discordUserId, appealReason }) {
  const result = await executeQuery(
    `INSERT INTO discord_punishment_appeals (punishment_id, discord_user_id, appeal_reason)
     VALUES (?, ?, ?)`,
    [punishmentId, discordUserId, appealReason]
  );

  await executeQuery(
    `UPDATE discord_punishments SET status = 'APPEAL_PENDING', appeal_id = ? WHERE id = ?`,
    [result.insertId, punishmentId]
  );

  return result.insertId;
}

/**
 * Get an appeal by ID.
 */
export async function getAppealById(id) {
  const rows = await executeQuery(
    `SELECT a.*, p.type AS punishment_type, p.reason AS punishment_reason,
            p.target_discord_user_id, p.target_discord_tag, p.created_at AS punishment_created_at,
            p.expires_at AS punishment_expires_at, p.actor_name_snapshot
     FROM discord_punishment_appeals a
     JOIN discord_punishments p ON a.punishment_id = p.id
     WHERE a.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Get appeals for a specific punishment.
 */
export async function getAppealsByPunishment(punishmentId) {
  return executeQuery(
    `SELECT * FROM discord_punishment_appeals WHERE punishment_id = ? ORDER BY created_at DESC`,
    [punishmentId]
  );
}

/**
 * Get all pending appeals.
 */
export async function getPendingAppeals() {
  return executeQuery(
    `SELECT a.*, p.type AS punishment_type, p.reason AS punishment_reason,
            p.target_discord_user_id, p.target_discord_tag, p.actor_name_snapshot
     FROM discord_punishment_appeals a
     JOIN discord_punishments p ON a.punishment_id = p.id
     WHERE a.status = 'PENDING'
     ORDER BY a.created_at ASC`
  );
}

/**
 * Review (approve or reject) an appeal.
 */
export async function reviewAppeal({ appealId, status, reviewerDiscordUserId, reviewerNotes }) {
  await executeQuery(
    `UPDATE discord_punishment_appeals
     SET status = ?, reviewer_discord_user_id = ?, reviewer_notes = ?, reviewed_at = NOW()
     WHERE id = ?`,
    [status, reviewerDiscordUserId, reviewerNotes || null, appealId]
  );

  const appeal = await getAppealById(appealId);
  if (!appeal) return;

  if (status === "APPROVED") {
    await executeQuery(
      `UPDATE discord_punishments SET status = 'APPEALED', lifted_at = NOW() WHERE id = ?`,
      [appeal.punishment_id]
    );
  } else if (status === "REJECTED") {
    await executeQuery(
      `UPDATE discord_punishments SET status = 'APPEAL_REJECTED' WHERE id = ?`,
      [appeal.punishment_id]
    );
  }
}

/**
 * Check whether a Discord user already has an active punishment of the given type.
 */
export async function hasActivePunishment(targetDiscordUserId, type) {
  const rows = await executeQuery(
    `SELECT id FROM discord_punishments
     WHERE target_discord_user_id = ? AND type = ? AND status = 'ACTIVE'
     LIMIT 1`,
    [targetDiscordUserId, type]
  );
  return rows.length > 0;
}

/**
 * Get all Discord punishments for a user (by discord ID or player ID).
 * Used for profile integration — merges results when user links later.
 */
export async function getDiscordPunishmentsForProfile({ discordUserId, playerId }) {
  const conditions = [];
  const params = [];

  if (discordUserId) {
    conditions.push("target_discord_user_id = ?");
    params.push(discordUserId);
  }

  if (playerId) {
    conditions.push("target_player_id = ?");
    params.push(playerId);
  }

  if (!conditions.length) return [];

  return executeQuery(
    `SELECT * FROM discord_punishments
     WHERE ${conditions.join(" OR ")}
     ORDER BY created_at DESC
     LIMIT 50`,
    params
  );
}

/**
 * Check if a player has an active web ban (TEMP_BAN or PERM_BAN on WEB platform).
 */
export async function hasActiveWebBan(playerId) {
  if (!playerId) return false;
  const rows = await executeQuery(
    `SELECT id FROM discord_punishments
     WHERE target_player_id = ? AND platform = 'WEB'
       AND type IN ('TEMP_BAN', 'PERM_BAN')
       AND status = 'ACTIVE'
     LIMIT 1`,
    [playerId]
  );
  return rows.length > 0;
}

/**
 * Get all web punishments (paginated, for dashboard).
 * actor_player_id is a v1.10.0 column that may not exist yet — use the
 * actor_name_snapshot column (always present) for actor identification.
 */
export async function getWebPunishments({ page = 1, limit = 25 } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRows] = await Promise.all([
    executeQuery(
      `SELECT dp.*, u.username AS target_username
       FROM discord_punishments dp
       LEFT JOIN users u ON dp.target_player_id = u.userId
       WHERE dp.platform = 'WEB'
       ORDER BY dp.created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    ),
    executeQuery(
      `SELECT COUNT(*) AS total FROM discord_punishments WHERE platform = 'WEB'`
    ),
  ]);

  return {
    punishments: rows,
    total: countRows[0]?.total || 0,
    page,
    limit,
  };
}

/**
 * Get active web punishments for a player (for enforcement display).
 */
export async function getActiveWebPunishments(playerId) {
  if (!playerId) return [];
  return executeQuery(
    `SELECT * FROM discord_punishments
     WHERE target_player_id = ? AND platform = 'WEB' AND status = 'ACTIVE'
     ORDER BY created_at DESC`,
    [playerId]
  );
}
