import { Command, RegisterBehavior } from "@sapphire/framework";
import { Colors, EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import { UserGetter } from "../controllers/userController.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../features.json");

import { internalApiHeaders } from "../api/common.js";
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
        )
    );
  }

  async chatInputRun(interaction) {
    if (!features.report) {
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

    const reporterUser = interaction.user.id;
    const reportedUser = interaction.options.getUser("user").username;
    const reportReason = interaction.options.getString("reason");

    // Resolve the reporter user to a User ID in database.
    const reporterUserData = new UserGetter();
    const userData = await reporterUserData.byDiscordId(reporterUser);
    
    if (!userData.discordId) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("User not Linked")
        .setDescription(
          `There was an error submitting your report as your account isn't linked. Please link your account by going to ${process.env.siteAddress} and login.`
        )
        .setColor(Colors.Red);

      return interaction.reply({
        embeds: [errorEmbed],
        ephemeral: true,
      });
    }

    //
    // Send report to the API
    //
    const reportURL = `${process.env.siteAddress}/api/report/create`;
    const response = await fetch(reportURL, {
      method: "POST",
      headers: internalApiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        reporterUser: userData.username,
        reportedUser: reportedUser,
        reportReason: reportReason,
        reportPlatform: "DISCORD",
      }),
    });   

    const apiData = await response.json();
    if (!apiData.success) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("Failed to Submit Report")
        .setDescription(
          "There was an error submitting your report. Please try again later."
        )
        .setColor(Colors.Red);

      interaction.reply({
        embeds: [errorEmbed],
        ephemeral: true,
      });
    } else {
      const successEmbed = new EmbedBuilder()
        .setTitle("Report Submitted")
        .setDescription(
          `You have reported \`${reportedUser}\` for: "${reportReason}".`
        )
        .setColor(Colors.Green);

      interaction.reply({
        embeds: [successEmbed],
        ephemeral: true,
      });
    }
  }
}