import db from "./databaseController.js";

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
          AND (startDate IS NULL OR startDate <= NOW())
          AND (endDate IS NULL OR endDate >= NOW())
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
          AND (startDate IS NULL OR startDate <= NOW())
          AND (endDate IS NULL OR endDate >= NOW())
        ORDER BY COALESCE(startDate, updatedDate, NOW()) ASC`
    );
    return rows;
  } catch (error) {
    console.error("Error fetching popup announcements:", error);
    return [];
  }
}
