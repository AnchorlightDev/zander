/**
 * cron/forumBridgeCron.js
 *
 * Starts the website -> Discord half of the forum bridge (subscribes to forum
 * events) and runs its outbox every minute, so anything that failed because
 * Discord was down or rate limited is retried. Finished outbox rows are pruned
 * once a day.
 *
 * Gated on features.discord.forumBridge at run time.
 */

import cron from "node-cron";
import { createRequire } from "module";
import {
  processForumOutbox,
  pruneForumOutbox,
  refreshBridgeCache,
  startForumBridgeSync,
} from "../lib/forums/forumBridgeSync.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

startForumBridgeSync();

const outboxTask = cron.schedule("* * * * *", async () => {
  if (!features.discord?.forumBridge) return;
  try {
    await refreshBridgeCache();
    await processForumOutbox();
  } catch (error) {
    console.error("[forumBridgeCron] Outbox run failed:", error);
  }
});

const pruneTask = cron.schedule("17 3 * * *", async () => {
  try {
    await pruneForumOutbox();
  } catch (error) {
    console.error("[forumBridgeCron] Outbox prune failed:", error);
  }
});

outboxTask.start();
pruneTask.start();
