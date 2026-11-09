/**
 * cron/schedulerCron.js
 *
 * The unified scheduler's per-minute runner. It finds due jobs, claims each run
 * exactly once, and executes the job's actions in order (see
 * services/schedulerRunner.mjs). It replaced the old scheduledDiscordMessages
 * embed loop, whose rows were migrated into jobs in migration 0082.
 */
import cron from "node-cron";
import { createRequire } from "module";
import { client } from "../controllers/discordController.js";
import { tick } from "../services/schedulerRunner.mjs";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");

const schedulerTask = cron.schedule("*/1 * * * *", async () => {
  try {
    await tick({ now: new Date(), client, config });
  } catch (error) {
    console.error("[schedulerCron] tick failed:", error?.message || error);
  }
});

schedulerTask.start();
