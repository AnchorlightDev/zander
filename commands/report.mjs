import { Command } from "@sapphire/framework";
import {
  ActionRowBuilder,
  ApplicationCommandType,
  Colors,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import fetch from "node-fetch";
import { UserGetter } from "../controllers/userController.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

import { internalApiHeaders } from "../api/common.js";

// reports.reportReason is VARCHAR(100).
const REASON_MAX_LENGTH = 100;

// The evidence is shown to staff as a webhook embed field, which Discord caps
// at 1024 characters. The quoted message is trimmed well under that so the
// link, author and channel lines always fit alongside it.
const QUOTED_CONTENT_MAX_LENGTH = 700;

const MESSAGE_REPORT_MODAL_PREFIX = "report_message_modal_";

function errorEmbed(title, description) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(Colors.Red);
}

/**
 * Build the evidence block for a reported Discord message: a jump link plus
 * who said what, where and when, so staff can act on it even if the message is
 * later deleted.
 */
export function buildMessageEvidence(message) {
  const lines = [
    `Message: ${message.url}`,
    `Author: ${message.author?.username ?? "unknown"} (${message.author?.id ?? "unknown"})`,
  ];
  if (message.channelId) lines.push(`Channel: <#${message.channelId}>`);
  if (message.createdTimestamp) {
    lines.push(`Sent: <t:${Math.floor(message.createdTimestamp / 1000)}:f>`);
  }

  let content = (message.content || "").trim();
  if (content.length > QUOTED_CONTENT_MAX_LENGTH) {
    content = `${content.slice(0, QUOTED_CONTENT_MAX_LENGTH)}… (truncated)`;
  }
  if (content) lines.push("", "Content:", content);

  const attachmentCount = message.attachments?.size ?? 0;
  if (attachmentCount) lines.push("", `Attachments: ${attachmentCount} (see message link)`);

  return lines.join("\n");
}

export class ReportCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("report")
        .setDescription("Report a player for misconduct or breaking the rules.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The Discord user you want to report.")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("The reason for reporting the user.")
            .setRequired(true)
            // reports.reportReason is VARCHAR(100). Discord enforces this in
            // the client, so a long reason is caught before submission rather
            // than being silently truncated by the API.
            .setMaxLength(REASON_MAX_LENGTH)
        )
    );

    // Right-click a message → Apps → Report Message.
    registry.registerContextMenuCommand((builder) =>
      builder.setName("Report Message").setType(ApplicationCommandType.Message)
    );
  }

  async chatInputRun(interaction) {
    if (!features.report) {
      return interaction.reply({
        embeds: [errorEmbed("Feature Disabled", "This feature has been disabled by your System Administrator.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    const reportedUser = interaction.options.getUser("user").username;
    const reportReason = interaction.options.getString("reason");

    return this.submitReport(interaction, { reportedUser, reportReason });
  }

  async contextMenuRun(interaction) {
    if (!interaction.isMessageContextMenuCommand()) return;

    if (!features.report) {
      return interaction.reply({
        embeds: [errorEmbed("Feature Disabled", "This feature has been disabled by your System Administrator.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    const message = interaction.targetMessage;

    if (message.author?.id === interaction.user.id) {
      return interaction.reply({
        embeds: [errorEmbed("Can't Report", "You can't report your own message.")],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (message.author?.bot || message.webhookId) {
      return interaction.reply({
        embeds: [
          errorEmbed(
            "Can't Report",
            "Messages from bots and webhooks can't be reported. If this message relays something a player said in-game, report them with `/report` or open a ticket."
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // The modal has to be the first response (Discord allows 3 seconds), so
    // the linked-account check runs after it is submitted, in submitReport().
    const modalId = `${MESSAGE_REPORT_MODAL_PREFIX}${interaction.id}`;
    const reasonInput = new TextInputBuilder()
      .setCustomId("reason")
      .setLabel(`Why are you reporting ${message.author?.username ?? "this message"}?`.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(REASON_MAX_LENGTH);

    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle("Report Message")
      .addComponents(new ActionRowBuilder().addComponents(reasonInput));

    await interaction.showModal(modal);

    let modalInteraction;
    try {
      modalInteraction = await interaction.awaitModalSubmit({
        filter: (submitted) => submitted.customId === modalId && submitted.user.id === interaction.user.id,
        time: 5 * 60 * 1000,
      });
    } catch {
      return; // closed or timed out — nothing was sent, nothing to say
    }

    return this.submitReport(modalInteraction, {
      reportedUser: message.author?.username ?? "unknown",
      reportReason: modalInteraction.fields.getTextInputValue("reason").trim(),
      reportReasonEvidence: buildMessageEvidence(message),
    });
  }

  /**
   * Shared by /report and the "Report Message" context menu: resolve the
   * reporter's linked account and send the report to the API.
   */
  async submitReport(interaction, { reportedUser, reportReason, reportReasonEvidence = null }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Resolve the reporter user to a User ID in database.
    const userData = await new UserGetter().byDiscordId(interaction.user.id);

    if (!userData?.discordId) {
      return interaction.editReply({
        embeds: [
          errorEmbed(
            "User not Linked",
            `There was an error submitting your report as your account isn't linked. Please link your account by going to ${process.env.siteAddress} and login.`
          ),
        ],
      });
    }

    let apiData = null;
    try {
      const response = await fetch(`${process.env.siteAddress}/api/report/create`, {
        method: "POST",
        headers: internalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          reporterUser: userData.username,
          reportedUser,
          reportReason,
          reportReasonEvidence,
          reportPlatform: "DISCORD",
        }),
      });
      apiData = await response.json();
    } catch (error) {
      console.error("[report] failed to submit report:", error);
    }

    if (!apiData?.success) {
      return interaction.editReply({
        embeds: [
          errorEmbed("Failed to Submit Report", "There was an error submitting your report. Please try again later."),
        ],
      });
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Report Submitted")
          .setDescription(`You have reported \`${reportedUser}\` for: "${reportReason}".`)
          .setColor(Colors.Green),
      ],
    });
  }
}
