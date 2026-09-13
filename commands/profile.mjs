import { Command, RegisterBehavior } from "@sapphire/framework";
import { Colors, EmbedBuilder } from "discord.js";
import moment from "moment";
import {
  getProfilePicture,
  getUserStats,
  getUserLastSession,
  UserGetter,
} from "../controllers/userController.js";
import { getUserRanks } from "../services/profileService.js";
import { getBadgesForUser } from "../controllers/badgeController.js";
import { resolveDiscordUserId } from "../lib/discord/resolveDiscordMember.mjs";

export class ProfileCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("profile")
        .setDescription("Display profile for yourself or another player.")
        .addStringOption((option) =>
          option
            .setName("username")
            .setDescription("Minecraft username of the profile to fetch.")
            .setRequired(false)
        )
        .addUserOption((option) =>
          option
            .setName("discord_user")
            .setDescription("Discord user to fetch the linked profile for.")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("discord_tag")
            .setDescription(
              "Discord tag, ID, or @username of the profile to fetch."
            )
            .setRequired(false)
        )
    );
  }

  async chatInputRun(interaction) {
    const username = interaction.options.getString("username");
    const discordUser = interaction.options.getUser("discord_user");
    const discordTag = interaction.options.getString("discord_tag");

    if (!username && !discordUser && !discordTag) {
      return interaction.reply({
        content:
          "Please provide either a Minecraft username or a Discord user/tag to look up a profile.",
        ephemeral: true,
      });
    }

    // Acknowledge immediately — the DB/HTTP lookups below can take long enough
    // to blow past Discord's 3s ack window, which causes a hard-to-diagnose
    // "Interaction has already been acknowledged" error on the eventual reply.
    try {
      await interaction.deferReply();
    } catch (error) {
      console.error("Failed to defer profile command reply:", error);
      return;
    }

    let resolvedDiscordId = null;
    if (!username) {
      resolvedDiscordId = await resolveDiscordUserId(interaction, {
        discordUser,
        discordTag,
      });

      if (!resolvedDiscordId) {
        return interaction.editReply({
          content:
            "Unable to resolve the provided Discord information to a linked account.",
        });
      }
    }

    // Looked up in-process (same as the web profile page) instead of an HTTP
    // self-call to the bot's own siteAddress, which is unreliable when that
    // outbound request can't complete (DNS/WAF/network hairpinning).
    let apiData;
    try {
      const userGetter = new UserGetter();
      const userRecord = username
        ? await userGetter.byUsername(username)
        : await userGetter.byDiscordId(resolvedDiscordId);

      if (!userRecord) {
        apiData = { success: false };
      } else {
        const [profilePicture, profileStats, profileSession, ranks, badges] = await Promise.all([
          getProfilePicture(userRecord.username),
          getUserStats(userRecord.userId),
          getUserLastSession(userRecord.userId),
          getUserRanks(userRecord.username),
          getBadgesForUser(userRecord.userId),
        ]);

        apiData = {
          success: true,
          data: {
            profileData: userRecord,
            profilePicture,
            profileStats,
            profileSession,
            ranks,
            badges,
          },
        };
      }
    } catch (err) {
      console.error("[profile command] Failed to look up profile:", err);
      return interaction.editReply({
        content: "Failed to look up the profile. Please try again later.",
      });
    }

    if (!apiData.success) {
      const isDiscordLookup = !username;
      const noProfileEmbed = new EmbedBuilder()
        .setTitle("Could not fetch profile.")
        .setDescription(
          isDiscordLookup
            ? "This user is not linked to a website account."
            : "User either does not exist or there was an issue fetching profile."
        )
        .setColor(Colors.Red);

      return interaction.editReply({
        embeds: [noProfileEmbed],
      });
    } else {
      let isLinked = apiData.data.profileData.discordId;
      let profilePicture = apiData.data.profilePicture;

      const embed = new EmbedBuilder();

      if (isLinked) {
        embed.setTitle(`\`${apiData.data.profileData.username}\`'s Profile ✅`);
      } else {
        embed.setTitle(`${apiData.data.profileData.username}'s Profile`);
      }

      const session = apiData.data.profileSession || {};
      const serverName = session.server
        ? `${session.server.charAt(0).toUpperCase()}${session.server.slice(1)}`
        : "the network";

      let statusLine = "";

      if (session.isOnline) {
        statusLine = `Currently Online on ${serverName}`;
      } else if (session.lastOnlineDiff) {
        statusLine = `Last Online ${session.lastOnlineDiff} ago on ${serverName}`;
      } else {
        statusLine = "Last online information unavailable";
      }

      embed
        .setDescription(statusLine)
        .setColor(Colors.Blurple)
        .setThumbnail(profilePicture)
        .addFields(
          {
            name: "Date Joined",
            value: `${moment(apiData.data.profileData.joined).format(
              "LLLL"
            )} (${moment(apiData.data.profileData.joined).fromNow()})`,
            inline: false,
          },
          {
            name: "Total Logins",
            value: `${apiData.data.profileStats.totalLogins}`,
            inline: true,
          },
          {
            name: "Total Playtime",
            value: `${apiData.data.profileStats.totalPlaytime}`,
            inline: true,
          }
        );

      // Discord embed field values are capped at 1024 chars — truncate the
      // line list (rather than the count) so as many entries as possible
      // are still shown in full.
      const buildFieldValue = (lines) => {
        const LIMIT = 1024;
        const full = lines.join("\n");
        if (full.length <= LIMIT) return full;

        const shown = [];
        let length = 0;
        for (const line of lines) {
          const next = length + (shown.length ? 1 : 0) + line.length;
          if (next > LIMIT - 20) break;
          shown.push(line);
          length = next;
        }
        return `${shown.join("\n")}\n*+${lines.length - shown.length} more*`;
      };

      const ranks = apiData.data.ranks || [];
      if (ranks.length > 0) {
        const sorted = [...ranks].sort((a, b) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity));
        const rankLines = sorted.map((r) => {
          const tags = [r.isStaff ? "Staff" : null, r.isDonator ? "Supporter" : null].filter(Boolean);
          const suffix = tags.length ? ` (${tags.join(", ")})` : "";
          return `• ${r.displayName}${r.title ? ` — *${r.title}*` : ""}${suffix}`;
        });
        embed.addFields({ name: `Ranks (${ranks.length})`, value: buildFieldValue(rankLines), inline: false });
      }

      const badges = apiData.data.badges || [];
      if (badges.length > 0) {
        const badgeLines = badges.map((b) => `🏅 ${b.name}`);
        embed.addFields({ name: `Badges (${badges.length})`, value: buildFieldValue(badgeLines), inline: false });
      }

      return interaction.editReply({ embeds: [embed] });
    }
  }
}
