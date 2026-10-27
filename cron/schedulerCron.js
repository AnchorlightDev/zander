import cron from "node-cron";
import { EmbedBuilder } from "discord.js";
import db from "../controllers/databaseController.js";
import { client } from "../controllers/discordController.js";
import { hashEmail } from "../api/common.js";
import { htmlToDiscordMarkdown } from "../lib/discord/htmlToDiscordMarkdown.mjs";

const executeQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.query(query, params, (error, results) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(results);
    });
  });

async function buildAvatarUrl(profile) {
  if (!profile) return null;

  if (profile.profilePicture_type === "GRAVATAR" && profile.profilePicture_email) {
    const emailHash = await hashEmail(profile.profilePicture_email);
    return `https://gravatar.com/avatar/${emailHash}?size=200`;
  }

  if (profile.profilePicture_type === "CRAFTATAR" && profile.uuid) {
    return `https://crafthead.net/helm/${profile.uuid}`;
  }

  return null;
}

const schedulerTask = cron.schedule("*/1 * * * *", async () => {
  if (!client?.isReady?.()) return;

  try {
    const pendingMessages = await executeQuery(
      `SELECT * FROM scheduledDiscordMessages WHERE status='scheduled' AND sentAt IS NULL AND scheduledFor <= UTC_TIMESTAMP() ORDER BY scheduledFor ASC LIMIT 20`
    );

    for (const message of pendingMessages) {
      try {
        const channel = await client.channels.fetch(message.channelId);
        if (!channel?.isTextBased?.()) {
          throw new Error("Scheduled channel is not text-based.");
        }

        const [userProfile] = await executeQuery(
          "SELECT username, profilePicture_type, profilePicture_email, uuid FROM users WHERE userId = ? LIMIT 1",
          [message.createdBy]
        );
        const avatarUrl = await buildAvatarUrl(userProfile);
        const footerText = `Message authorised by ${
          userProfile?.username ?? "System"
        }`;

        const embed = new EmbedBuilder();

        if (message.embedTitle) {
          embed.setTitle(message.embedTitle);
        }

        if (message.embedDescription) {
          // The dashboard editor stores rich-text HTML, but Discord renders
          // Markdown — convert so tags don't show up literally in the embed.
          const description = htmlToDiscordMarkdown(message.embedDescription);
          if (description) embed.setDescription(description);
        }

        if (message.embedColor) {
          const colorValue = parseInt(
            String(message.embedColor).replace("#", ""),
            16
          );
          if (!Number.isNaN(colorValue)) {
            embed.setColor(colorValue);
          }
        }

        embed.setFooter({
          text: footerText,
          iconURL: avatarUrl || undefined,
        });

        await channel.send({ embeds: [embed] });

        await executeQuery(
          "UPDATE scheduledDiscordMessages SET status='sent', sentAt=UTC_TIMESTAMP(), lastError=NULL WHERE scheduleId=?",
          [message.scheduleId]
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : `${error}`;
        await executeQuery(
          "UPDATE scheduledDiscordMessages SET status='failed', lastError=? WHERE scheduleId=?",
          [errorMessage, message.scheduleId]
        );
      }
    }
  } catch (error) {
    console.error("schedulerCron: failed to send scheduled messages", error);
  }
});

schedulerTask.start();
