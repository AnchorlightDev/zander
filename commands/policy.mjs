import { Command, RegisterBehavior } from "@sapphire/framework";
import pkg, { Colors } from "discord.js";
const { EmbedBuilder } = pkg;

export class PolicyCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("policy")
        .setDescription(
          "Display Network policy (Rules, Terms, Privacy, and Refund)"
        )
    );
  }

  async chatInputRun(interaction) {
    const embed = new EmbedBuilder()
      .setTitle("Network Policy")
      .setColor(Colors.Gold)
      .setDescription(
        "For user reference, here is a link to all Network policies.\nBy joining the Network and using our services you agree to all our policies."
      )
      .addFields(
        {
          name: "Rules",
          value: `${process.env.siteAddress}/rules`,
          inline: false,
        },
        {
          name: "Terms Of Service",
          value: `${process.env.siteAddress}/terms`,
          inline: false,
        },
        {
          name: "Privacy Policy",
          value: `${process.env.siteAddress}/privacy`,
          inline: false,
        },
        {
          name: "Refund Policy",
          value: `${process.env.siteAddress}/refund`,
          inline: false,
        }
      );

    const messageContent = {
      embeds: [embed],
    };

    interaction.reply(messageContent);
  }
}
