import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, WebhookClient } from "discord.js";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";

export class GuildMessageUpdateListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageUpdate",
    });
  }

  async run(oldMessage, newMessage) {
    // Check if the author is a bot and stop if true.
    if (newMessage.author.bot) return;

    const webhookUrl = config.discord.webhooks.adminLog;
    if (!webhookUrl) return;

    const webhook = new WebhookClient({ url: webhookUrl });

    const embed = new EmbedBuilder()
      .setTitle("Message Edit")
      .setColor(Colors.Yellow)
      .setDescription(
        `Message edit from \`${oldMessage.author.username}\` in \`#${oldMessage.channel.name}\``
      )
      .addFields(
        { name: "Old Message", value: (oldMessage.content || "[empty]").slice(0, 1024), inline: false },
        { name: "Edited Message", value: (newMessage.content || "[empty]").slice(0, 1024), inline: false }
      );

    const jumpButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Jump to Message")
        .setStyle(ButtonStyle.Link)
        .setURL(newMessage.url)
    );

    await sendWebhookMessage(webhook, { embeds: [embed], components: [jumpButton] }, {
      context: "listeners/messageUpdate",
    });
  }
}
