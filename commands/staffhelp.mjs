import { Command, RegisterBehavior } from "@sapphire/framework";
import { Colors, EmbedBuilder, InteractionContextType, MessageFlags } from "discord.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";

// One staff ping per user per window, so the command can't flood the staff channel.
const REQUEST_COOLDOWN_MS = 2 * 60 * 1000;
const lastRequestAt = new Map();

export class StaffHelpCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("staffhelp")
        .setDescription("Sends a message to our Staff for help or assistance.")
        .setContexts(InteractionContextType.Guild)
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

    const now = Date.now();
    const lastAt = lastRequestAt.get(interaction.user.id) || 0;
    if (now - lastAt < REQUEST_COOLDOWN_MS) {
      const retryAt = Math.ceil((lastAt + REQUEST_COOLDOWN_MS) / 1000);
      return interaction.reply({
        content: `You've just sent a request. You can send another <t:${retryAt}:R>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Acknowledge first: the webhook send below retries with backoff and can
    // run past Discord's 3-second window.
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      console.error("Failed to defer staffhelp reply:", error);
      return;
    }

    // Hold the slot while the (retrying) send runs so repeat invocations in
    // that window are refused; released again below if the send fails.
    lastRequestAt.set(interaction.user.id, now);

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
      if (lastRequestAt.get(interaction.user.id) === now) {
        if (lastAt) lastRequestAt.set(interaction.user.id, lastAt);
        else lastRequestAt.delete(interaction.user.id);
      }
      return interaction.editReply({
        content:
          "We were unable to send your assistance request. Please try again later.",
      });
    }

    for (const [userId, at] of lastRequestAt) {
      if (now - at >= REQUEST_COOLDOWN_MS) lastRequestAt.delete(userId);
    }

    return interaction.editReply({
      embeds: [staffAssistanceConfirmed],
    });
  }
}
