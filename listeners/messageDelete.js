import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, WebhookClient } from "discord.js";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";

export class GuildMessageDeleteListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageDelete",
    });
  }

  async run(message) {
    // Check if the author of the deleted message is a bot and stop if true.
    if (message.author.bot) return;

    const webhookUrl = config.discord.webhooks.adminLog;
    if (!webhookUrl) return;

    const webhook = new WebhookClient({ url: webhookUrl });

    const embed = new EmbedBuilder()
      .setTitle("Message Delete")
      .setColor(Colors.Red)
      .setDescription(
        `Message deleted from \`${message.author.username}\` in \`#${message.channel.name}\``
      )
      .addFields(
        { name: "Deleted Message", value: message.content || "[empty]", inline: false }
      );

    const channelUrl = `https://discord.com/channels/${message.guild.id}/${message.channel.id}`;
    const jumpButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Jump to Channel")
        .setStyle(ButtonStyle.Link)
        .setURL(channelUrl)
    );

    await sendWebhookMessage(webhook, { embeds: [embed], components: [jumpButton] }, {
      context: "listeners/messageDelete",
    });
  }
}
