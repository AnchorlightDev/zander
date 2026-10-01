/**
 * unverifiedReminderCron.js
 *
 * Every 30 days (on the 1st of each month at 10:00 UTC), sends a DM to all
 * guild members who:
 *   - are NOT linked to a real (non-placeholder) website account, AND
 *   - do NOT have the verified role, AND
 *   - have at least one non-@everyone role assigned (indicating they are known
 *     to the server but haven't completed account linking)
 *
 * If the linked-account lookup fails, no reminders are sent.
 *
 * Members with closed DMs are silently skipped.
 */

import cron from "node-cron";
import { client } from "../controllers/discordController.js";
import db from "../controllers/databaseController.js";
import { needsVerificationReminder } from "../lib/discord/unverifiedReminder.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");

const REMINDER_MESSAGE = `Hello! 👋
Our system shows that your account still needs to be verified.
Please link your account by visiting the page below and following the steps: https://craftingforchrist.net/login
If you have any issues, you can join our Discord and our team will be happy to help: https://craftingforchrist.net/discord`;

function queryDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

export async function sendUnverifiedReminders() {
  if (!features.discord.events.unverifiedReminder) return;

  const guildId = config.discord.guildId;
  if (!guildId) {
    console.warn("[UnverifiedReminderCron] No guildId configured. Skipping.");
    return;
  }

  const verifiedRoleId = config.discord.roles.verified;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.warn("[UnverifiedReminderCron] Guild not found in cache. Skipping.");
    return;
  }

  // Throws on failure, so a DB outage never turns into a DM to every member.
  const linkedRows = await queryDb(
    `SELECT discordId FROM users WHERE discordId IS NOT NULL AND is_placeholder = 0`
  );
  const linkedDiscordIds = new Set(linkedRows.map((r) => String(r.discordId)));

  // Fetch all members to ensure the cache is populated.
  await guild.members.fetch();

  const unverified = guild.members.cache.filter((member) =>
    needsVerificationReminder(member, linkedDiscordIds, verifiedRoleId)
  );

  console.log(`[UnverifiedReminderCron] Found ${unverified.size} unverified member(s) with roles. Sending reminders…`);

  let sent = 0;
  let failed = 0;

  for (const [, member] of unverified) {
    try {
      await member.send(REMINDER_MESSAGE);
      sent++;
    } catch (err) {
      // Common errors: DiscordAPIError[50007] Cannot send messages to this user (DMs closed)
      failed++;
      if (err.code !== 50007) {
        console.warn(`[UnverifiedReminderCron] Failed to DM ${member.user.tag}: ${err.message}`);
      }
    }
  }

  console.log(`[UnverifiedReminderCron] Done. Sent: ${sent}, Skipped (closed DMs): ${failed}.`);
}

// Run at 10:00 UTC on the 1st of each month (~every 30 days).
const unverifiedReminderTask = cron.schedule(
  "0 10 1 * *",
  async () => {
    try {
      await sendUnverifiedReminders();
    } catch (error) {
      console.error("[UnverifiedReminderCron] Unexpected error:", error);
    }
  },
  { timezone: "UTC" }
);

unverifiedReminderTask.start();

console.log("[UnverifiedReminderCron] Scheduled unverified member reminder on the 1st of each month at 10:00 UTC.");
