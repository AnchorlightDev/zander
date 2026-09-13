import cron from "node-cron";
import db from "../controllers/databaseController.js";
import { invalidateWebAnnouncementCache } from "../controllers/announcementController.js";

// Run every 5 minutes — delete any announcements whose endDate has passed.
const announcementExpiryTask = cron.schedule("*/5 * * * *", () => {
  db.query(
    `DELETE FROM announcements WHERE endDate IS NOT NULL AND endDate < NOW()`,
    function (error, results) {
      if (error) {
        return console.error("[announcementExpiryCron] Delete failed:", error);
      }
      if (results.affectedRows > 0) {
        console.log(
          `[announcementExpiryCron] Deleted ${results.affectedRows} expired announcement(s).`
        );
        // Bust the in-memory cache so the next page load doesn't serve a
        // just-deleted announcement.
        invalidateWebAnnouncementCache();
      }
    }
  );
});

announcementExpiryTask.start();
