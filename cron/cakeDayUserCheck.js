import cron from "node-cron";
import db from "../controllers/databaseController.js";
import { Colors } from "discord.js";
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");
import moment from "moment";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";

var cakeDayUserCheckTask = cron.schedule("0 7 * * *", async () => {
  console.log("[CakeDayUserCheck] Running daily cake day check...");
  try {
    const results = await new Promise((resolve, reject) => {
      db.query(
        `SELECT * FROM users
         WHERE account_registered IS NOT NULL
           AND DATE_FORMAT(joined, '%m-%d') = DATE_FORMAT(CURDATE(), '%m-%d')
           AND YEAR(joined) != YEAR(CURDATE())
           AND account_disabled = 0
           AND audit_lastWebsiteLogin >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)`,
        (error, rows) => {
          if (error) return reject(error);
          resolve(rows);
        }
      );
    });

    console.log(`[CakeDayUserCheck] Found ${results.length} user(s) with a cake day today.`);

    const welcomeHook = new Webhook(config.discord.webhooks.welcome);

    for (const user of results) {
      try {
        const years = moment().diff(moment(user.joined), "years");

        const embed = new MessageBuilder()
          .setTitle(`🎂 Happy cake day to ${user.username}! 🎉`)
          .setDescription(
            `Celebrating ${years} year${years !== 1 ? "s" : ""} with ${config.siteConfiguration.siteName}`
          )
          .setColor(Colors.Blurple)
          .setFooter(
            `To get your cake day mention, make sure you are a member on our website.`
          );

        await sendWebhookMessage(welcomeHook, embed, {
          context: "cron/cakeDayUserCheck",
        });

        console.log(`[CakeDayUserCheck] Announced cake day for ${user.username} (${years} year(s)).`);
      } catch (userError) {
        console.error(`[CakeDayUserCheck] Failed to announce cake day for ${user.username}:`, userError);
      }
    }

    console.log("[CakeDayUserCheck] Done.");
  } catch (error) {
    console.error("[CakeDayUserCheck] Error:", error);
  }
});

cakeDayUserCheckTask.start();
