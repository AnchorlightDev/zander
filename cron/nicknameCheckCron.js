import cron from "node-cron";
import { client } from "../controllers/discordController.js";
import { runBulkNicknameCheck } from "../lib/discord/nicknameCheck.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");

async function runScheduledNicknameCheck() {
  if (!features.discord.events.nicknameCheck) return;

  const reportChannelId = config.discord.nicknameReportChannelId;
  if (!reportChannelId) {
    console.warn("[NicknameCheckCron] No nicknameReportChannelId configured. Skipping.");
    return;
  }

  const guildId = config.discord.guildId;
  if (!guildId) {
    console.warn("[NicknameCheckCron] No guildId configured. Skipping.");
    return;
  }

  const mismatches = await runBulkNicknameCheck(client, guildId, {
    reportChannelId,
    title: "Scheduled Nickname Check",
  });

  if (mismatches.length) {
    console.log(`[NicknameCheckCron] Reported ${mismatches.length} nickname mismatch(es).`);
  } else {
    console.log("[NicknameCheckCron] All linked users have valid nicknames.");
  }
}

// Run every 6 hours
const nicknameCheckTask = cron.schedule("0 */6 * * *", async () => {
  try {
    await runScheduledNicknameCheck();
  } catch (error) {
    console.error("[NicknameCheckCron] Failed to run nickname check:", error);
  }
});

nicknameCheckTask.start();

console.log("[NicknameCheckCron] Scheduled nickname check every 6 hours.");
