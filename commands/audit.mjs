import { Command } from "@sapphire/framework";
import { Colors, EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import { resolveDiscordUserId } from "../lib/discord/resolveDiscordMember.mjs";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { formatDiscordTimestamp } from "../lib/discord/discordFormatting.mjs";
import {
  getUserPermissions,
  UserGetter,
} from "../controllers/userController.js";

const AUDIT_PERMISSION_NODE = "zander.web.audit";

import { internalApiHeaders } from "../api/common.js";
function formatAuditTimestamp(value) {
  return formatDiscordTimestamp(value);
}

export class AuditCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("audit")
        .setDescription("Audit activity for a linked user across all platforms.")
        .addStringOption((option) =>
          option
            .setName("username")
            .setDescription("Minecraft username of the user to audit.")
            .setRequired(false)
        )
        .addUserOption((option) =>
          option
            .setName("discord_user")
            .setDescription("Discord user whose linked account should be audited.")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("discord_tag")
            .setDescription("Discord tag, ID, or @username of the user to audit.")
            .setRequired(false)
        )
    );
  }

  async chatInputRun(interaction) {
    const username = interaction.options.getString("username");
    const discordUser = interaction.options.getUser("discord_user");
    const discordTag = interaction.options.getString("discord_tag");

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (error) {
      console.error("Failed to defer audit command reply", error);
      return;
    }

    const userGetter = new UserGetter();
    const linkedAccount = await userGetter.byDiscordId(interaction.user.id);

    if (!linkedAccount) {
      const notLinkedEmbed = new EmbedBuilder()
        .setTitle("No Linked Account")
        .setDescription(
          "We couldn't find a linked site account for you. Please link your account before using audit commands."
        )
        .setColor(Colors.Red);

      return interaction.editReply({
        embeds: [notLinkedEmbed],
      });
    }

    const userPermissions = await getUserPermissions(linkedAccount);
    if (!hasPermission(userPermissions, AUDIT_PERMISSION_NODE)) {
      const noPermissionEmbed = new EmbedBuilder()
        .setTitle("No Permission")
        .setDescription("You do not have access to use this command.")
        .setColor(Colors.Red);

      return interaction.editReply({
        embeds: [noPermissionEmbed],
      });
    }

    if (!username && !discordUser && !discordTag) {
      return interaction.editReply({
        content:
          "Please provide a Minecraft username or Discord user/tag to audit.",
      });
    }

    const fetchURL = new URL(
      `${process.env.siteAddress}/api/user/profile/get`
    );

    if (username) {
      fetchURL.searchParams.set("username", username);
    } else {
      const resolvedDiscordId = await resolveDiscordUserId(interaction, {
        discordUser,
        discordTag,
      });

      if (!resolvedDiscordId) {
        return interaction.editReply({
          content:
            "Unable to resolve the provided Discord information to a linked account.",
        });
      }

      fetchURL.searchParams.set("discordId", resolvedDiscordId);
    }

    let apiData;
    try {
      const response = await fetch(fetchURL, {
        headers: internalApiHeaders(),
      });

      apiData = await response.json();
    } catch (error) {
      console.error("Failed to fetch audit profile data", error);
      return interaction.editReply({
        content:
          "We were unable to fetch profile information at this time. Please try again shortly.",
      });
    }

    if (!apiData?.success || !apiData.data?.profileData) {
      return interaction.editReply({
        content: "No linked user was found for the provided information.",
      });
    }

    const profileData = apiData.data.profileData;

    const embed = new EmbedBuilder()
      .setTitle(`Audit report for ${profileData.username}`)
      .setColor(Colors.Blurple)
      .setTimestamp(new Date())
      .addFields(
        {
          name: "Discord Message",
          value: formatAuditTimestamp(profileData.audit_lastDiscordMessage),
          inline: false,
        },
        {
          name: "Discord Voice",
          value: formatAuditTimestamp(profileData.audit_lastDiscordVoice),
          inline: false,
        },
        {
          name: "Minecraft Login",
          value: formatAuditTimestamp(profileData.audit_lastMinecraftLogin),
          inline: false,
        },
        {
          name: "Minecraft Message",
          value: formatAuditTimestamp(profileData.audit_lastMinecraftMessage),
          inline: false,
        },
        {
          name: "Minecraft Punishment",
          value: formatAuditTimestamp(profileData.audit_lastMinecraftPunishment),
          inline: false,
        },
        {
          name: "Discord Punishment",
          value: formatAuditTimestamp(profileData.audit_lastDiscordPunishment),
          inline: false,
        },
        {
          name: "Website Login",
          value: formatAuditTimestamp(profileData.audit_lastWebsiteLogin),
          inline: false,
        }
      );

    if (profileData.discordId) {
      embed.setDescription(`Linked Discord: <@${profileData.discordId}>`);
    } else {
      embed.setDescription("No Discord account is linked to this user.");
    }

    return interaction.editReply({
      embeds: [embed],
    });
  }
}
