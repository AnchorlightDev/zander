import { Command } from "@sapphire/framework";
import {Colors, EmbedBuilder, MessageFlags, InteractionContextType } from "discord.js";
import {
  getUserPermissions,
  UserGetter,
} from "../controllers/userController.js";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { runBulkNicknameCheck } from "../lib/discord/nicknameCheck.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");

const NICKNAME_CHECK_PERMISSION = "zander.web.nicknamecheck";

export class NicknameCheckCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("nicknamecheck")
        .setContexts(InteractionContextType.Guild)
        .setDescription(
          "Manually scan all linked users and report nickname mismatches."
        )
    );
  }

  async chatInputRun(interaction) {
    // Defer if not already deferred by the framework
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    try {
      if (!features.discord.events.nicknameCheck) {
        const disabledEmbed = new EmbedBuilder()
          .setTitle("Feature Disabled")
          .setDescription(
            "The nickname check feature has been disabled by your System Administrator."
          )
          .setColor(Colors.Red);

        return interaction.editReply({ embeds: [disabledEmbed] });
      }

      const userGetter = new UserGetter();
      const linkedAccount = await userGetter.byDiscordId(interaction.user.id);

      if (!linkedAccount) {
        const notLinkedEmbed = new EmbedBuilder()
          .setTitle("No Linked Account")
          .setDescription(
            "We couldn't find a linked site account for you. Please link your account before using this command."
          )
          .setColor(Colors.Red);

        return interaction.editReply({ embeds: [notLinkedEmbed] });
      }

      const userPermissions = await getUserPermissions(linkedAccount);
      if (!hasPermission(userPermissions, NICKNAME_CHECK_PERMISSION)) {
        const noPermEmbed = new EmbedBuilder()
          .setTitle("No Permission")
          .setDescription("You do not have access to use this command.")
          .setColor(Colors.Red);

        return interaction.editReply({ embeds: [noPermEmbed] });
      }

      const reportChannelId = config.discord.nicknameReportChannelId;
      if (!reportChannelId) {
        return interaction.editReply({
          content: "No nickname report channel has been configured.",
        });
      }

      const guildId = config.discord.guildId;
      if (!guildId) {
        return interaction.editReply({
          content: "No guild ID has been configured.",
        });
      }

      const mismatches = await runBulkNicknameCheck(
        interaction.client,
        guildId,
        {
          reportChannelId,
          title: "Manual Nickname Check",
        }
      );

      if (mismatches.length === 0) {
        const successEmbed = new EmbedBuilder()
          .setTitle("Nickname Check Complete")
          .setDescription(
            "All linked users have a valid Discord nickname matching their Minecraft username."
          )
          .setColor(Colors.Green)
          .setTimestamp();

        return interaction.editReply({ embeds: [successEmbed] });
      }

      const resultEmbed = new EmbedBuilder()
        .setTitle("Nickname Check Complete")
        .setDescription(
          `Found **${mismatches.length}** mismatch(es). Results have been posted to <#${reportChannelId}>.`
        )
        .setColor("#ff9900")
        .setTimestamp();

      return interaction.editReply({ embeds: [resultEmbed] });
    } catch (error) {
      console.error("[NicknameCheckCommand] Error:", error);

      const errorEmbed = new EmbedBuilder()
        .setTitle("Nickname Check Error")
        .setDescription(
          "An error occurred while running the nickname check. Please try again later."
        )
        .setColor(Colors.Red);

      return interaction.editReply({ embeds: [errorEmbed] });
    }
  }
}
