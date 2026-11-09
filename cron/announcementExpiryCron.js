import cron from "node-cron";
import db from "../controllers/databaseController.js";
import { invalidateWebAnnouncementCache } from "../controllers/announcementController.js";

// Run every 5 minutes — disable (do not delete) any announcements whose endDate
// has passed. Expired rows stay listed under the "Ended" filter; deleting is a
// manual action. endDate is stored in UTC (mysql2 pool timezone "Z").
const announcementExpiryTask = cron.schedule("*/5 * * * *", () => {
  db.query(
    `UPDATE announcements
        SET enabled = 0, updatedDate = UTC_TIMESTAMP(3)
      WHERE enabled = 1 AND endDate IS NOT NULL AND endDate < UTC_TIMESTAMP(3)`,
    function (error, results) {
      if (error) {
        return console.error("[announcementExpiryCron] Expiry update failed:", error);
      }
      if (results.affectedRows > 0) {
        console.log(
          `[announcementExpiryCron] Disabled ${results.affectedRows} expired announcement(s).`
        );
        // Bust the in-memory cache so the next page load doesn't serve a
        // just-disabled announcement.
        invalidateWebAnnouncementCache();
      }
    }
  );
});

announcementExpiryTask.start();
