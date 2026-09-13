/**
 * Event Announcement Cron
 * Checks every minute for pending event announcements that are due and sends them.
 */

import cron from "node-cron";
import { processDueAnnouncements } from "../services/eventAnnouncementService.js";

const eventAnnouncementTask = cron.schedule("*/1 * * * *", async () => {
  try {
    const results = await processDueAnnouncements();
    if (results.sent > 0 || results.failed > 0) {
      console.log(`[EventAnnouncementCron] Processed: ${results.sent} sent, ${results.failed} failed`);
    }
  } catch (error) {
    console.error("[EventAnnouncementCron] Error:", error);
  }
});

eventAnnouncementTask.start();
