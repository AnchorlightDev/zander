import { Command, RegisterBehavior } from "@sapphire/framework";
import pkg, { Colors, MessageFlags } from "discord.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../features.json");
const { EmbedBuilder } = pkg;

export class PolicyCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("apply")
        .setDescription(
          "Display information and description for Applications."
        )
    );
  }

  async chatInputRun(interaction) {
    if (!features.applications) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("Feature Disabled")
        .setDescription(
          `This feature has been disabled by your System Administrator.`
        )
        .setColor(Colors.Red);

      return interaction.reply({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("Network Applications")
      .setColor(Colors.Gold)
      .setDescription(
        `Want to join our staff team and help make our server even better? Apply for open positions here: ${process.env.siteAddress}/apply`
      );

    const messageContent = {
      embeds: [embed],
    };

    interaction.reply(messageContent);
  }
}
