/**
 * lib/discord/scheduledEmbed.mjs
 *
 * Shared builder for scheduled Discord embeds. Moved out of cron/schedulerCron.js
 * so the scheduler runner and the discord_message action build embeds the same
 * way. The description is rich-text HTML from the dashboard editor, converted to
 * Discord Markdown so tags don't show up literally.
 */
import { EmbedBuilder } from "discord.js";
import { htmlToDiscordMarkdown } from "./htmlToDiscordMarkdown.mjs";

export function buildScheduledEmbed({ title, descriptionHtml, color, footerText, iconURL } = {}) {
  const embed = new EmbedBuilder();

  if (title) embed.setTitle(String(title).slice(0, 256));

  if (descriptionHtml) {
    const description = htmlToDiscordMarkdown(descriptionHtml);
    if (description) embed.setDescription(description);
  }

  if (color) {
    const value = parseInt(String(color).replace("#", ""), 16);
    if (!Number.isNaN(value)) embed.setColor(value);
  }

  if (footerText) embed.setFooter({ text: String(footerText).slice(0, 2048), iconURL: iconURL || undefined });

  return embed;
}
