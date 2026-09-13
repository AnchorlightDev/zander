import { Command, RegisterBehavior } from "@sapphire/framework";
import { Colors, EmbedBuilder } from "discord.js";

export class WebsiteCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("website")
        .setDescription("Display link to the Network Website")
    );
  }

  async chatInputRun(interaction) {
    const embed = new EmbedBuilder()
      .setTitle(`Network Website`)
      .setDescription(
        `For more info and to get involved with the community, jump on our website ${process.env.siteAddress}`
      )
      .setColor(Colors.DarkGold);

    interaction.reply({
      embeds: [embed],
      ephemeral: true,
    });
  }
}
