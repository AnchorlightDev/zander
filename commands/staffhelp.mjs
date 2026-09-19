import { Command, RegisterBehavior } from "@sapphire/framework";
import { Colors, EmbedBuilder, MessageFlags } from "discord.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";

export class StaffHelpCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("staffhelp")
        .setDescription("Sends a message to our Staff for help or assistance.")
        .addStringOption((option) =>
          option
            .setName("query")
            .setDescription("What you need help with?")
            .setRequired(true)
        )
    );
  }

  async chatInputRun(interaction) {
    const userQuery = interaction.options.getString("query");

    const staffAssistanceEmbed = new MessageBuilder ()
      .setTitle(
        `Staff Assistance Requested by \`${interaction.user.username}\``
      )
      .setDescription(`**Request:** ${userQuery}`)
      .setColor(Colors.Gold);

    const staffAssistanceConfirmed = new EmbedBuilder()
      .setTitle(`Staff Assistance Requested`)
      .setDescription(`Assistance request has been sent.`)
      .setColor(Colors.Green);

    const staffChannelHook = new Webhook(
      config.discord.webhooks.staffChannel
    );

    const webhookSent = await sendWebhookMessage(
      staffChannelHook,
      staffAssistanceEmbed,
      { context: "commands/staffhelp" }
    );

    if (!webhookSent) {
      return interaction.reply({
        content:
          "We were unable to send your assistance request. Please try again later.",
        flags: MessageFlags.Ephemeral,
      });
    }

    interaction.reply({
      embeds: [staffAssistanceConfirmed],
      flags: MessageFlags.Ephemeral,
    });
  }
}
