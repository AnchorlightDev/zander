import db, { withPoolTransaction } from "./databaseController.js";
import { moveIdInOrder } from "../lib/hologramOrder.mjs";

function queryDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

// Simple TTL cache — avoids a DB hit on every page render across the entire app.
// Announcement content changes infrequently, so 30 seconds is a safe window.
let _webAnnouncementCache = undefined;
let _webAnnouncementExpiry = 0;
const WEB_ANNOUNCEMENT_TTL_MS = 30_000; // 30 seconds

/** Force the next getWebAnnouncement() call to re-query the database. */
export function invalidateWebAnnouncementCache() {
  _webAnnouncementCache = undefined;
  _webAnnouncementExpiry = 0;
}

export async function getWebAnnouncement() {
  const now = Date.now();
  if (_webAnnouncementCache !== undefined && now < _webAnnouncementExpiry) {
    return _webAnnouncementCache;
  }
  try {
    const rows = await queryDb(
      `SELECT * FROM announcements
        WHERE announcementType = 'web' AND enabled = 1
          AND (startDate IS NULL OR startDate <= UTC_TIMESTAMP(3))
          AND (endDate IS NULL OR endDate >= UTC_TIMESTAMP(3))
        ORDER BY RAND() LIMIT 1`
    );
    _webAnnouncementCache = rows.length > 0 ? rows[0] : null;
    _webAnnouncementExpiry = now + WEB_ANNOUNCEMENT_TTL_MS;
    return _webAnnouncementCache;
  } catch (error) {
    console.error("Error fetching web announcement:", error);
    return null;
  }
}

export async function getPopupAnnouncements() {
  try {
    const rows = await queryDb(
      `SELECT * FROM announcements
        WHERE announcementType = 'popup' AND enabled = 1
          AND (startDate IS NULL OR startDate <= UTC_TIMESTAMP(3))
          AND (endDate IS NULL OR endDate >= UTC_TIMESTAMP(3))
        ORDER BY COALESCE(startDate, updatedDate, UTC_TIMESTAMP(3)) ASC`
    );
    return rows;
  } catch (error) {
    console.error("Error fetching popup announcements:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (holograms are now an announcement platform)
// ---------------------------------------------------------------------------

/** Normalise a hologram group slug: trimmed, lowercased, falls back to "default". */
export function normaliseGroup(group) {
  const g = String(group ?? "").trim().toLowerCase();
  return g.length ? g.slice(0, 64) : "default";
}

/**
 * Minecraft renders stray control characters as boxed glyphs: textarea input
 * arrives with CRLF line endings, and emoji carry invisible variation
 * selectors / zero-width joiners. Normalise to plain \n and drop those.
 */
export function cleanHologramText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[︀-️​-‍⁠﻿]/g, "");
}

/**
 * Normalise a date-ish value into a Date (UTC) or null. Accepts an ISO string
 * (what the wizard submits) or a Date; anything unparseable becomes null. The
 * mysql2 pool runs with timezone "Z", so a Date is stored/read as UTC.
 */
export function normaliseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Strip Minecraft colour/format codes for a plain-text copy (list display).
 * Matches the SQL REGEXP used by migration 0081: legacy "&x" codes and hex
 * "&#RRGGBB". Placeholders like {countdown} are left intact.
 */
export function stripColourCodes(value) {
  if (value == null) return "";
  return String(value).replace(/&(#[0-9A-Fa-f]{6}|[0-9A-Fa-fK-Rk-r])/g, "");
}

// ---------------------------------------------------------------------------
// Hologram platform reads (frozen hub API shape) and reordering
// ---------------------------------------------------------------------------

/**
 * Every active hologram frame, in the exact shape and order GET
 * /api/hologram/messages has always returned: grouped by hologram group, then
 * sort order, then id. A frame is active when it is enabled and inside its
 * start/end window (holograms gained startDate support in 0081; migrated frames
 * have a null start, so this is byte-for-byte identical for existing data).
 * Expiry reuses endDate. UTC_TIMESTAMP(3) matches how the window is stored.
 */
export async function getActiveHologramFrames() {
  const rows = await queryDb(
    `SELECT hologramGroup, colourMessageFormat, link, countdownTo, countdownFinishedText
       FROM announcements
      WHERE announcementType = 'hologram' AND enabled = 1
        AND (startDate IS NULL OR startDate <= UTC_TIMESTAMP(3))
        AND (endDate   IS NULL OR endDate   >  UTC_TIMESTAMP(3))
      ORDER BY hologramGroup ASC, sortOrder ASC, announcementId ASC`
  );
  return rows.map((r) => ({
    group: r.hologramGroup,
    message: r.colourMessageFormat,
    link: r.link || null,
    countdownTo: r.countdownTo ? new Date(r.countdownTo).toISOString() : null,
    countdownFinishedText: r.countdownFinishedText || null,
  }));
}

/** Distinct hologram group slugs in use, for the wizard's group picker. */
export async function listHologramGroups() {
  const rows = await queryDb(
    `SELECT DISTINCT hologramGroup FROM announcements
      WHERE announcementType = 'hologram' AND hologramGroup IS NOT NULL
      ORDER BY hologramGroup ASC`
  );
  return rows.map((r) => r.hologramGroup);
}

/**
 * Nudge a hologram frame up or down within its group. Direction is "up"
 * (earlier) or "down" (later). The whole group is renumbered 0..n-1 in its new
 * order inside one transaction: new frames all default to sortOrder 0, so
 * swapping the two values alone would leave the order unchanged.
 */
export async function moveHologramFrame(id, direction) {
  const moved = await withPoolTransaction(async (q) => {
    const rows = await q(
      `SELECT announcementId, hologramGroup FROM announcements
        WHERE announcementId = ? AND announcementType = 'hologram' LIMIT 1`,
      [id]
    );
    const current = rows?.[0];
    if (!current) return false;

    const groupRows = await q(
      `SELECT announcementId, sortOrder FROM announcements
        WHERE announcementType = 'hologram' AND hologramGroup <=> ?
        ORDER BY sortOrder ASC, announcementId ASC
        FOR UPDATE`,
      [current.hologramGroup]
    );
    const nextOrder = moveIdInOrder(
      groupRows.map((r) => Number(r.announcementId)),
      Number(current.announcementId),
      direction
    );
    if (!nextOrder) return false;

    const previous = new Map(groupRows.map((r) => [Number(r.announcementId), r.sortOrder]));
    for (let index = 0; index < nextOrder.length; index += 1) {
      const frameId = nextOrder[index];
      if (previous.get(frameId) === index) continue;
      // eslint-disable-next-line no-await-in-loop
      await q(
        `UPDATE announcements SET sortOrder = ?, updatedDate = UTC_TIMESTAMP(3) WHERE announcementId = ?`,
        [index, frameId]
      );
    }
    return true;
  });
  if (moved) invalidateWebAnnouncementCache();
  return moved;
}

/**
 * Create a bare parent post row and return its postId. Used by writers that add
 * a single platform row of their own (the live-creator tip, event site
 * announcements) as well as the post service.
 */
export async function createAnnouncementPost({ title = null, createdBy = null } = {}) {
  const result = await queryDb(
    `INSERT INTO announcement_posts (title, createdBy, createdAt, updatedAt)
     VALUES (?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [title != null ? String(title).slice(0, 120) : null, createdBy ?? null]
  );
  return result?.insertId || null;
}
