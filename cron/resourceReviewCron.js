/**
 * Resource Review Cron
 * Every 15 minutes: re-counts pending resource votes (the reviewer list can
 * change) and flags submissions whose vote window closed without a majority.
 * Does nothing while the Resources module is off.
 */

import cron from "node-cron";
import { createRequire } from "module";
import { sweepPendingResources } from "../services/resourceReviewService.js";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

const resourceReviewTask = cron.schedule("*/15 * * * *", async () => {
  if (!features.resources) return;
  try {
    await sweepPendingResources();
  } catch (error) {
    console.error("[resourceReviewCron] Error:", error);
  }
});

resourceReviewTask.start();
