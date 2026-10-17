/**
 * controllers/hologramController.js
 *
 * Data-access layer for the dashboard-managed in-game hologram frames.
 *
 * A "frame" is one entry in a hologram's rotation. Frames belong to a
 * `hologram_group` ("default" is the shared/global rotation). The zander-hub
 * plugin places named holograms in the world (each tagged with a group), polls
 * the active frames for its groups, and cycles each hologram through them. A
 * frame's optional `link` is offered to a player who right-clicks the hologram
 * while that frame is showing.
 *
 * Raw SQL via the mysql2 pool, matching the other game-facing controllers.
 */
import db from "./databaseController.js";

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });
}

/** Normalise a group slug: trimmed, lowercased, falls back to "default". */
export function normaliseGroup(group) {
  const g = String(group ?? "").trim().toLowerCase();
  return g.length ? g.slice(0, 64) : "default";
}

/**
 * Every enabled frame, ordered for the hub to consume. The hub groups the flat
 * list by `hologram_group` itself, so a single query serves every hologram.
 */
export function getActiveMessages() {
  // An expired frame (expires_at set and in the past) drops out of the rotation
  // automatically, without anyone disabling it. UTC_TIMESTAMP() is always UTC,
  // matching how expires_at is stored (mysql2 pool timezone "Z").
  return runQuery(
    `SELECT id, hologram_group, message, link, countdown_to, countdown_finished_text, sort_order
       FROM hologram_messages
      WHERE enabled = 1
        AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
      ORDER BY hologram_group ASC, sort_order ASC, id ASC`
  );
}

/**
 * Normalise a countdown target into a Date (UTC) or null. Accepts an ISO string
 * (what the dashboard form submits) or a Date; anything unparseable becomes null,
 * which clears the countdown. The mysql2 pool runs with timezone "Z", so a Date is
 * stored and read back as UTC.
 */
export function normaliseCountdownTo(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalise a frame expiry into a Date (UTC) or null. Same parsing as
 * normaliseCountdownTo — an ISO string / Date becomes a UTC Date, anything
 * unparseable (or empty) becomes null, meaning the frame never expires.
 */
export const normaliseExpiresAt = normaliseCountdownTo;

/** Every frame (enabled or not), for the dashboard list. */
export function getAllMessages() {
  return runQuery(
    `SELECT * FROM hologram_messages
      ORDER BY hologram_group ASC, sort_order ASC, id ASC`
  );
}

export function getMessageById(id) {
  return runQuery(`SELECT * FROM hologram_messages WHERE id = ? LIMIT 1`, [id]).then(
    (rows) => rows?.[0] || null
  );
}

/** Distinct group slugs already in use (to populate the dashboard group picker). */
export function getGroups() {
  return runQuery(
    `SELECT DISTINCT hologram_group FROM hologram_messages ORDER BY hologram_group ASC`
  ).then((rows) => rows.map((r) => r.hologram_group));
}

export function createMessage({ hologram_group, message, link = null, countdown_to = null, countdown_finished_text = null, expires_at = null, sort_order = 0, enabled = 1 }) {
  return runQuery(
    `INSERT INTO hologram_messages (hologram_group, message, link, countdown_to, countdown_finished_text, expires_at, sort_order, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normaliseGroup(hologram_group),
      String(message ?? ""),
      link || null,
      normaliseCountdownTo(countdown_to),
      countdown_finished_text || null,
      normaliseExpiresAt(expires_at),
      Number(sort_order) || 0,
      enabled ? 1 : 0,
    ]
  );
}

export function updateMessage(id, { hologram_group, message, link = null, countdown_to = null, countdown_finished_text = null, expires_at = null, sort_order = 0, enabled = 1 }) {
  return runQuery(
    `UPDATE hologram_messages
        SET hologram_group = ?, message = ?, link = ?, countdown_to = ?, countdown_finished_text = ?, expires_at = ?, sort_order = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`,
    [
      normaliseGroup(hologram_group),
      String(message ?? ""),
      link || null,
      normaliseCountdownTo(countdown_to),
      countdown_finished_text || null,
      normaliseExpiresAt(expires_at),
      Number(sort_order) || 0,
      enabled ? 1 : 0,
      id,
    ]
  );
}

export function setEnabled(id, enabled) {
  return runQuery(
    `UPDATE hologram_messages SET enabled = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [enabled ? 1 : 0, id]
  );
}

export function deleteMessage(id) {
  return runQuery(`DELETE FROM hologram_messages WHERE id = ?`, [id]);
}

/**
 * Nudge a frame up or down within its group by swapping sort_order with its
 * neighbour. Direction is "up" (earlier) or "down" (later).
 */
export async function moveMessage(id, direction) {
  const current = await getMessageById(id);
  if (!current) return false;

  const comparator = direction === "up" ? "<" : ">";
  const order = direction === "up" ? "DESC" : "ASC";

  const neighbours = await runQuery(
    `SELECT id, sort_order FROM hologram_messages
      WHERE hologram_group = ?
        AND (sort_order ${comparator} ? OR (sort_order = ? AND id ${comparator} ?))
      ORDER BY sort_order ${order}, id ${order}
      LIMIT 1`,
    [current.hologram_group, current.sort_order, current.sort_order, id]
  );
  const neighbour = neighbours?.[0];
  if (!neighbour) return false;

  await runQuery(`UPDATE hologram_messages SET sort_order = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [neighbour.sort_order, current.id]);
  await runQuery(`UPDATE hologram_messages SET sort_order = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [current.sort_order, neighbour.id]);
  return true;
}
