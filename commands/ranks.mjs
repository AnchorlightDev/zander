import { Command, RegisterBehavior } from "@sapphire/framework";
import { Colors, EmbedBuilder } from "discord.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

export class RanksCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("ranks")
        .setDescription("Display link to view rank perks and donate.")
    );
  }

  async chatInputRun(interaction) {
    if (!features.ranks) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("Feature Disabled")
        .setDescription(
          `This feature has been disabled by your System Administrator.`
        )
        .setColor(Colors.Red);

      return interaction.reply({
        embeds: [errorEmbed],
        ephemeral: true,
      });      
    }

    const embed = new EmbedBuilder()
      .setTitle(`Ranks`)
      .setDescription(
        `We are looking always donations to keep this Server running since running this Network isn't free. If you would like to donate to ${config.siteConfiguration.siteName} check out our ranks and perks at ${process.env.siteAddress}/ranks`
      )
      .setColor(Colors.DarkGold);

    interaction.reply({
      embeds: [embed],
      empheral: false,
    });
  }
}
