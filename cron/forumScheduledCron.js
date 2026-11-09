/**
 * Forum scheduler cron.
 *
 * Runs every minute and publishes any forum threads whose scheduled publish
 * time has passed (status = 'scheduled', publishAt <= now). Publishing stamps
 * the thread's post time to the moment it goes live -- see
 * publishDiscussion()/publishDueScheduledDiscussions() in forumController.
 */

import cron from "node-cron";
import { createRequire } from "module";
import { publishDueScheduledDiscussions } from "../controllers/forumController.js";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

const forumScheduledTask = cron.schedule("* * * * *", async () => {
  // Read the flag at run time: features is the shared, live object.
  if (!features.forums) return;

  try {
    const published = await publishDueScheduledDiscussions();
    if (published.length) {
      console.log(
        `[forumScheduledCron] Published ${published.length} scheduled discussion(s): ${published.join(", ")}`
      );
    }
  } catch (error) {
    console.error("[forumScheduledCron] Failed to publish scheduled discussions:", error);
  }
});

forumScheduledTask.start();
