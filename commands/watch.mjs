import { Command } from "@sapphire/framework";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../config.json");

export class WatchCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("watch")
        .setDescription("Get a link to the community Watch page for streams and videos")
    );
  }

  async chatInputRun(interaction) {
    const siteAddress = process.env.siteAddress;
    const watchUrl = siteAddress ? `${siteAddress}/watch` : null;

    const embed = new EmbedBuilder()
      .setTitle("Watch")
      .setDescription("Check out live streams and videos from our creators on the Watch page.")
      .setColor(0xe74c3c)
      .setTimestamp();

    if (!watchUrl) {
      return interaction.reply({ embeds: [embed] });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Watch Now")
        .setStyle(ButtonStyle.Link)
        .setURL(watchUrl)
        .setEmoji({ name: "📺" })
    );

    return interaction.reply({ embeds: [embed], components: [row] });
  }
}
