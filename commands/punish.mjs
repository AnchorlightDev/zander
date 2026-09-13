import { Command } from "@sapphire/framework";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  WebhookClient,
} from "discord.js";
import { createRequire } from "module";
import fetch from "node-fetch";
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { resolveDiscordUserId } from "../lib/discord/resolveDiscordMember.mjs";
import { formatDiscordTimestamp } from "../lib/discord/discordFormatting.mjs";
import {
  getUserPermissions,
  UserGetter,
} from "../controllers/userController.js";
import { getUserPunishments } from "../services/profileService.js";
import {
  createPunishment,
  getActivePunishments,
  getPunishmentHistory,
  liftPunishment,
  hasActivePunishment,
} from "../controllers/discordPunishmentController.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");

const PUNISHMENT_TYPES = {
  warn: "WARN",
  kick: "DISCORD_KICK",
  tempban: "TEMP_BAN",
  ban: "PERM_BAN",
  tempmute: "TEMP_MUTE",
  mute: "PERM_MUTE",
};

const PERMISSION_NODES = config.discord?.punishments?.permissions || {
  can_warn: "zander.discord.punish.warn",
  can_kick: "zander.discord.punish.kick",
  can_ban: "zander.discord.punish.ban",
  can_mute: "zander.discord.punish.mute",
  can_view_history: "zander.discord.punish.history",
};

const SUBCOMMAND_PERMISSION_MAP = {
  warn: PERMISSION_NODES.can_warn,
  kick: PERMISSION_NODES.can_kick,
  tempban: PERMISSION_NODES.can_ban,
  ban: PERMISSION_NODES.can_ban,
  tempmute: PERMISSION_NODES.can_mute,
  mute: PERMISSION_NODES.can_mute,
  unban: PERMISSION_NODES.can_ban,
  unmute: PERMISSION_NODES.can_mute,
  history: PERMISSION_NODES.can_view_history,
};

const APPEAL_URL = `${process.env.siteAddress}${config.discord?.punishments?.appealBaseUrl || "/appeal"}`;
const LOG_CHANNEL_ID = config.discord?.punishments?.logChannelId;
const MUTED_ROLE_ID = config.discord?.roles?.muted;
const GUILD_ID = config.discord?.guildId;
const PUNISHMENT_WEBHOOK_URL = config.discord?.webhooks?.staffPunishmentNotifications;

const MAX_HISTORY_PUNISHMENTS = 50;
const HISTORY_PER_PAGE = 5;
const HISTORY_PAGINATION_TIMEOUT_MS = 2 * 60 * 1000;
const HISTORY_CUSTOM_IDS = {
  previous: "punish_history:previous",
  next: "punish_history:next",
};

// --- Minecraft punishment formatting helpers (ported from punishments.mjs) ---

function sanitizeText(value) {
  if (value === null || value === undefined) return null;
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  return collapsed || null;
}

function truncateText(value, maxLength = 256) {
  if (!value) return null;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatActor(username, userId) {
  const cleaned = sanitizeText(username);
  if (cleaned) return cleaned;
  if (userId) return `User ID ${userId}`;
  return null;
}

function parseFlag(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "0" || normalized === "false" || normalized === "no") return false;
  return true;
}

function hasTimestamp(value) {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value === "number") return Number.isFinite(value);
  return Number.isFinite(Date.parse(value));
}

function formatMcPunishmentStatus(punishment) {
  const type = String(punishment.type ?? "").toLowerCase();
  if (type === "kick") return "Completed";
  if (type === "warning") return "Logged";
  if (hasTimestamp(punishment.dateRemoved)) return "Removed";
  const active = Number(punishment.active);
  if (Number.isFinite(active) && active === 1) return "Active";
  if (Number.isFinite(active) && active === 0) return "Inactive";
  return null;
}

function shouldIncludeMcExpiry(punishment) {
  const type = String(punishment.type ?? "").toLowerCase();
  if (!hasTimestamp(punishment.dateEnd)) return false;
  return type !== "kick" && type !== "warning";
}

function toTitleCase(value) {
  if (!value) return "Unknown";
  const lowercase = String(value).toLowerCase();
  return lowercase.charAt(0).toUpperCase() + lowercase.slice(1);
}

function formatMcPunishmentDetails(punishment) {
  const lines = [];
  lines.push(`**Issued:** ${formatDiscordTimestamp(punishment.dateStart, { fallback: "Unknown" })}`);
  const reason = truncateText(sanitizeText(punishment.reason), 512);
  if (reason) lines.push(`**Reason:** ${reason}`);
  const server = sanitizeText(punishment.server);
  if (server) lines.push(`**Server:** ${server}`);
  const status = formatMcPunishmentStatus(punishment);
  if (status) lines.push(`**Status:** ${status}`);
  if (shouldIncludeMcExpiry(punishment)) {
    lines.push(`**Expires:** ${formatDiscordTimestamp(punishment.dateEnd, { fallback: "No expiry" })}`);
  }
  if (hasTimestamp(punishment.dateRemoved)) {
    lines.push(`**Removed:** ${formatDiscordTimestamp(punishment.dateRemoved, { fallback: "Unknown" })}`);
  }
  const removalReason = truncateText(sanitizeText(punishment.reasonRemoved), 512);
  if (removalReason) lines.push(`**Removal Reason:** ${removalReason}`);
  const actor = formatActor(punishment.bannedByUsername, punishment.bannedByUserId);
  if (actor) lines.push(`**Issued By:** ${actor}`);
  if (hasTimestamp(punishment.dateRemoved)) {
    const removedBy = formatActor(punishment.removedByUsername, punishment.removedByUserId);
    if (removedBy) lines.push(`**Removed By:** ${removedBy}`);
  }
  if (parseFlag(punishment.silent)) lines.push("**Silent:** Yes");
  if (!lines.length) return "No additional details available.";
  const value = lines.join("\n");
  return value.length > 1024 ? `${value.slice(0, 1021)}...` : value;
}

function formatDiscordPunishmentDetails(punishment) {
  const lines = [];
  lines.push(`**Issued:** ${formatDiscordTimestamp(punishment.created_at, { fallback: "Unknown" })}`);
  if (punishment.reason) lines.push(`**Reason:** ${punishment.reason.slice(0, 512)}`);
  lines.push(`**Status:** ${punishment.status}`);
  if (punishment.expires_at) {
    lines.push(`**Expires:** ${formatDiscordTimestamp(punishment.expires_at, { fallback: "N/A" })}`);
  }
  if (punishment.lifted_at) {
    lines.push(`**Lifted:** ${formatDiscordTimestamp(punishment.lifted_at, { fallback: "Unknown" })}`);
  }
  if (punishment.actor_name_snapshot) {
    lines.push(`**Issued By:** ${punishment.actor_name_snapshot}`);
  }
  if (!lines.length) return "No additional details available.";
  const value = lines.join("\n");
  return value.length > 1024 ? `${value.slice(0, 1021)}...` : value;
}

function buildHistoryEmbed({ displayName, profileData, punishments, totalCount, truncated, page }) {
  const totalPages = Math.max(1, Math.ceil(punishments.length / HISTORY_PER_PAGE));
  const embed = new EmbedBuilder()
    .setTitle(`Punishments for ${displayName}`)
    .setColor(Colors.DarkRed)
    .setTimestamp(new Date())
    .setFooter({ text: `Page ${page + 1} of ${totalPages}` });

  const descParts = [];
  if (profileData?.discordId) descParts.push(`Linked Discord: <@${profileData.discordId}>`);
  let totalLine = `Total punishments: ${totalCount}`;
  if (truncated) totalLine += ` (showing first ${punishments.length})`;
  totalLine += ".";
  descParts.push(totalLine);

  const start = page * HISTORY_PER_PAGE;
  const pagePunishments = punishments.slice(start, start + HISTORY_PER_PAGE);
  const end = Math.min(start + pagePunishments.length, punishments.length);
  if (totalPages > 1) descParts.push(`Viewing ${start + 1}-${end} of ${punishments.length}.`);
  if (descParts.length) embed.setDescription(descParts.join("\n"));

  const fields = pagePunishments.map((p, index) => {
    const platformTag = p._platform === "Minecraft" ? "MC" : "Discord";
    const typeName = p._platform === "Minecraft" ? toTitleCase(p.type) : formatType(p.type);
    const details = p._platform === "Minecraft"
      ? formatMcPunishmentDetails(p)
      : formatDiscordPunishmentDetails(p);
    return {
      name: `${start + index + 1}. [${platformTag}] ${typeName}`,
      value: details,
    };
  }).filter((f) => f.value);

  if (fields.length) embed.addFields(fields);
  return embed;
}

function buildHistoryPaginationComponents(page, totalPages) {
  if (totalPages <= 1) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(HISTORY_CUSTOM_IDS.previous)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("◀️")
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(HISTORY_CUSTOM_IDS.next)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("▶️")
        .setDisabled(page >= totalPages - 1),
    ),
  ];
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDurationLabel(durationMs) {
  if (!durationMs) return "forever";
  const totalSeconds = Math.floor(durationMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
  return parts.length ? parts.join(", ") : "forever";
}

/**
 * Send a webhook notification for a punishment.
 * Matches the format: title line, bullet points for details.
 * @param {string} platform - 'Discord' or 'Web'
 */
export async function sendPunishmentWebhook({
  type,
  targetTag,
  actorTag,
  reason,
  durationMs,
  platform = "Discord",
  punishmentLink,
}) {
  if (!PUNISHMENT_WEBHOOK_URL) return;

  try {
    const webhookClient = new WebhookClient({ url: PUNISHMENT_WEBHOOK_URL });

    // Map type to a title verb (matching LiteBans style)
    const titleVerbs = {
      WARN: "Warned",
      DISCORD_KICK: "Kicked",
      TEMP_BAN: "Banned",
      PERM_BAN: "Banned",
      TEMP_MUTE: "Muted",
      PERM_MUTE: "Muted",
      UNBAN: "Unbanned",
      UNMUTE: "Unmuted",
      NATIVE_BAN: "Banned",
      NATIVE_KICK: "Kicked",
    };
    const verb = titleVerbs[type] || "Punished";

    // Map type to a "by" label
    const byLabels = {
      WARN: "Warned by",
      DISCORD_KICK: "Kicked by",
      TEMP_BAN: "Banned by",
      PERM_BAN: "Banned by",
      TEMP_MUTE: "Muted by",
      PERM_MUTE: "Muted by",
      UNBAN: "Unbanned by",
      UNMUTE: "Unmuted by",
      NATIVE_BAN: "Banned by",
      NATIVE_KICK: "Kicked by",
    };
    const byLabel = byLabels[type] || "Punished by";

    // Duration line is not shown for actions without a meaningful duration
    const noDurationTypes = ["DISCORD_KICK", "UNBAN", "UNMUTE", "NATIVE_BAN", "NATIVE_KICK"];
    const showDuration = !noDurationTypes.includes(type);
    const durationLabel = (type === "PERM_BAN" || type === "PERM_MUTE")
      ? "forever"
      : formatDurationLabel(durationMs);

    // Colour: red for bans, orange for mutes, yellow for warns, grey for kicks, green for lifts
    const colorMap = {
      WARN: "#FFC107",
      DISCORD_KICK: "#6C757D",
      TEMP_BAN: "#DC3545",
      PERM_BAN: "#DC3545",
      TEMP_MUTE: "#FD7E14",
      PERM_MUTE: "#FD7E14",
      UNBAN: "#28A745",
      UNMUTE: "#28A745",
      NATIVE_BAN: "#DC3545",
      NATIVE_KICK: "#6C757D",
    };

    const descLines = [
      `**${targetTag}** has been ${verb.toLowerCase()}!`,
      `\u2022 Platform: ${platform}`,
      `\u2022 ${byLabel}: ${actorTag}`,
    ];
    if (showDuration) {
      descLines.push(`\u2022 Duration: ${durationLabel}`);
    }
    descLines.push(`\u2022 Reason: ${reason}`);

    const embed = new EmbedBuilder()
      .setTitle(verb)
      .setDescription(descLines.join("\n"))
      .setColor(parseInt((colorMap[type] || "#DC3545").replace("#", ""), 16))
      .setTimestamp();

    const payload = { embeds: [embed] };

    if (punishmentLink) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("View Punishment")
          .setStyle(ButtonStyle.Link)
          .setURL(punishmentLink)
      );
      payload.components = [row];
    }

    await webhookClient.send(payload);
    webhookClient.destroy();
  } catch (error) {
    console.error("Failed to send punishment webhook notification:", error);
  }
}

/**
 * Parse a duration string like "1h", "7d", "30m", "2w" into milliseconds.
 * Returns null if invalid.
 */
function parseDuration(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^(\d+)\s*(m|h|d|w)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  const multipliers = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

/**
 * Get a snapshot of a Discord user's display info.
 */
export function getTargetTag(user) {
  if (!user) return null;
  return user.globalName || user.username || user.tag || `${user.id}`;
}

/**
 * Attempt to DM a user before a punishment action.
 * Returns dm_status string.
 */
async function sendPunishmentDm(user, { type, reason, guildName, expiresAt }) {
  try {
    const embed = new EmbedBuilder()
      .setTitle(`Discord ${formatType(type)}`)
      .setColor(Colors.Red)
      .setTimestamp(new Date());

    const lines = [
      `You have received a **${formatType(type).toLowerCase()}** in **${guildName}**.`,
      `**Reason:** ${reason}`,
    ];

    if (expiresAt) {
      const unixTs = Math.floor(expiresAt.getTime() / 1000);
      lines.push(
        `**Expires:** <t:${unixTs}:F> (<t:${unixTs}:R>)`
      );
    }

    lines.push(`\nYou may appeal this punishment at: ${APPEAL_URL}`);

    embed.setDescription(lines.join("\n"));

    await user.send({ embeds: [embed] });
    return "SENT";
  } catch (error) {
    if (error.code === 50007) {
      return "FAILED_CLOSED_DMS";
    }
    console.error("Failed to DM punishment target:", error);
    return "FAILED_UNKNOWN";
  }
}

/**
 * Format punishment type for display.
 */
function formatType(type) {
  const labels = {
    WARN: "Warning",
    DISCORD_KICK: "Kick",
    TEMP_BAN: "Temporary Ban",
    PERM_BAN: "Permanent Ban",
    TEMP_MUTE: "Temporary Mute",
    PERM_MUTE: "Permanent Mute",
  };
  return labels[type] || type;
}

/**
 * Send a log embed to the staff logging channel.
 */
async function sendLogEmbed(client, {
  type,
  targetUser,
  actorUser,
  reason,
  expiresAt,
  punishmentId,
  dmStatus,
  silent,
}) {
  if (!LOG_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel?.isTextBased?.()) return;

    const embed = new EmbedBuilder()
      .setTitle(`${formatType(type)}${silent ? " (Silent)" : ""}`)
      .setColor(Colors.DarkRed)
      .setTimestamp(new Date())
      .setFooter({ text: `Punishment ID: ${punishmentId}` });

    const fields = [
      { name: "Target", value: `<@${targetUser.id}> (${getTargetTag(targetUser)})`, inline: true },
      { name: "Staff", value: `<@${actorUser.id}>`, inline: true },
      { name: "Reason", value: reason.length > 1024 ? reason.slice(0, 1021) + "..." : reason },
    ];

    if (expiresAt) {
      const unixTs = Math.floor(expiresAt.getTime() / 1000);
      fields.push({
        name: "Expires",
        value: `<t:${unixTs}:F> (<t:${unixTs}:R>)`,
        inline: true,
      });
    }

    fields.push({ name: "DM Status", value: dmStatus, inline: true });

    embed.addFields(fields);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Failed to send punishment log embed:", error);
  }
}

/**
 * Check if actor can punish target based on role hierarchy.
 */
function canPunishMember(actorMember, targetMember) {
  if (!actorMember || !targetMember) return true;
  return actorMember.roles.highest.position > targetMember.roles.highest.position;
}

export class PunishCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    const builder = new SlashCommandBuilder()
      .setName("punish")
      .setDescription("Discord punishment commands for staff.")
      .addSubcommand((sub) =>
        sub
          .setName("warn")
          .setDescription("Issue a warning to a user.")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to warn.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for the warning.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("evidence").setDescription("Evidence URL (optional).").setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt.setName("silent").setDescription("If true, do not post a log message.").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("kick")
          .setDescription("Kick a user from the guild.")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to kick.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for the kick.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("evidence").setDescription("Evidence URL (optional).").setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt.setName("silent").setDescription("If true, do not post a log message.").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("tempban")
          .setDescription("Temporarily ban a user.")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to temp-ban.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for the ban.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName("duration")
              .setDescription("Duration (e.g. 1h, 7d, 2w).")
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("evidence").setDescription("Evidence URL (optional).").setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt.setName("silent").setDescription("If true, do not post a log message.").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("ban")
          .setDescription("Permanently ban a user.")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to ban.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for the ban.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("evidence").setDescription("Evidence URL (optional).").setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt.setName("silent").setDescription("If true, do not post a log message.").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("tempmute")
          .setDescription("Temporarily mute a user (chat + voice).")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to mute.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for the mute.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName("duration")
              .setDescription("Duration (e.g. 1h, 7d, 2w).")
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("evidence").setDescription("Evidence URL (optional).").setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt.setName("silent").setDescription("If true, do not post a log message.").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("mute")
          .setDescription("Permanently mute a user (chat + voice).")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to mute.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for the mute.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("evidence").setDescription("Evidence URL (optional).").setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt.setName("silent").setDescription("If true, do not post a log message.").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("unban")
          .setDescription("Unban a user.")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to unban.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for unbanning.").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("unmute")
          .setDescription("Unmute a user.")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("The user to unmute.").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason for unmuting.").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("history")
          .setDescription("View a user's punishment history (Minecraft & Discord).")
          .addUserOption((opt) =>
            opt.setName("user").setDescription("Discord user to look up.").setRequired(false)
          )
          .addStringOption((opt) =>
            opt.setName("username").setDescription("Minecraft username to look up.").setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName("discord_tag")
              .setDescription("Discord tag, ID, or @username to look up.")
              .setRequired(false)
          )
      );

    registry.registerChatInputCommand(builder);
  }

  async chatInputRun(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (error) {
      console.error("Failed to defer punish command reply:", error);
      return;
    }

    // Permission check: actor must have a linked account
    const userGetter = new UserGetter();
    const linkedAccount = await userGetter.byDiscordId(interaction.user.id);

    if (!linkedAccount) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Linked Account")
            .setDescription("You must have a linked site account to use punishment commands.")
            .setColor(Colors.Red),
        ],
      });
    }

    const userPermissions = await getUserPermissions(linkedAccount);
    const requiredNode = SUBCOMMAND_PERMISSION_MAP[subcommand];

    if (requiredNode && !hasPermission(userPermissions, requiredNode)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Permission")
            .setDescription("You do not have permission to use this command.")
            .setColor(Colors.Red),
        ],
      });
    }

    switch (subcommand) {
      case "warn":
        return this.handleWarn(interaction, linkedAccount);
      case "kick":
        return this.handleKick(interaction, linkedAccount);
      case "tempban":
        return this.handleTempBan(interaction, linkedAccount);
      case "ban":
        return this.handlePermBan(interaction, linkedAccount);
      case "tempmute":
        return this.handleTempMute(interaction, linkedAccount);
      case "mute":
        return this.handlePermMute(interaction, linkedAccount);
      case "unban":
        return this.handleUnban(interaction, linkedAccount);
      case "unmute":
        return this.handleUnmute(interaction, linkedAccount);
      case "history":
        return this.handleHistory(interaction);
      default:
        return interaction.editReply({ content: "Unknown subcommand." });
    }
  }

  async handleWarn(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const evidence = interaction.options.getString("evidence");
    const silent = interaction.options.getBoolean("silent") ?? false;

    const targetMember = await this.fetchGuildMember(interaction, targetUser.id);
    const actorMember = await this.fetchGuildMember(interaction, interaction.user.id);

    if (targetMember && actorMember && !canPunishMember(actorMember, targetMember)) {
      return interaction.editReply({
        embeds: [this.hierarchyErrorEmbed()],
      });
    }

    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);

    const dmStatus = await sendPunishmentDm(targetUser, {
      type: "WARN",
      reason,
      guildName: interaction.guild.name,
      expiresAt: null,
    });

    const punishmentId = await createPunishment({
      type: "WARN",
      targetDiscordUserId: targetUser.id,
      targetDiscordTag: getTargetTag(targetUser),
      targetPlayerId: targetLinked?.userId || null,
      actorDiscordUserId: interaction.user.id,
      actorNameSnapshot: getTargetTag(interaction.user),
      reason,
      expiresAt: null,
      context: this.buildContext(interaction, evidence),
      dmStatus,
    });

    if (!silent) {
      await sendLogEmbed(interaction.client, {
        type: "WARN",
        targetUser,
        actorUser: interaction.user,
        reason,
        expiresAt: null,
        punishmentId,
        dmStatus,
        silent,
      });
    }

    await sendPunishmentWebhook({
      type: "WARN",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: null,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Warning Issued")
          .setDescription(
            `<@${targetUser.id}> has been warned.\n**Reason:** ${reason}\n**DM Status:** ${dmStatus}\n**Punishment ID:** ${punishmentId}`
          )
          .setColor(Colors.Yellow)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handleKick(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const evidence = interaction.options.getString("evidence");
    const silent = interaction.options.getBoolean("silent") ?? false;

    const targetMember = await this.fetchGuildMember(interaction, targetUser.id);
    const actorMember = await this.fetchGuildMember(interaction, interaction.user.id);

    if (targetMember && actorMember && !canPunishMember(actorMember, targetMember)) {
      return interaction.editReply({ embeds: [this.hierarchyErrorEmbed()] });
    }

    if (!targetMember) {
      return interaction.editReply({
        content: "That user is not currently in the guild and cannot be kicked.",
      });
    }

    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);
    const dmStatus = await sendPunishmentDm(targetUser, {
      type: "DISCORD_KICK",
      reason,
      guildName: interaction.guild.name,
      expiresAt: null,
    });

    try {
      await targetMember.kick(`[Punish] ${reason}`);
    } catch (error) {
      console.error("Failed to kick member:", error);
      return interaction.editReply({
        content: "Failed to kick the user. The bot may lack permissions or the user has a higher role.",
      });
    }

    const punishmentId = await createPunishment({
      type: "DISCORD_KICK",
      targetDiscordUserId: targetUser.id,
      targetDiscordTag: getTargetTag(targetUser),
      targetPlayerId: targetLinked?.userId || null,
      actorDiscordUserId: interaction.user.id,
      actorNameSnapshot: getTargetTag(interaction.user),
      reason,
      expiresAt: null,
      context: this.buildContext(interaction, evidence),
      dmStatus,
    });

    if (!silent) {
      await sendLogEmbed(interaction.client, {
        type: "DISCORD_KICK",
        targetUser,
        actorUser: interaction.user,
        reason,
        expiresAt: null,
        punishmentId,
        dmStatus,
        silent,
      });
    }

    await sendPunishmentWebhook({
      type: "DISCORD_KICK",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: null,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User Kicked")
          .setDescription(
            `<@${targetUser.id}> has been kicked from the guild.\n**Reason:** ${reason}\n**DM Status:** ${dmStatus}\n**Punishment ID:** ${punishmentId}`
          )
          .setColor(Colors.Orange)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handleTempBan(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const durationStr = interaction.options.getString("duration");
    const evidence = interaction.options.getString("evidence");
    const silent = interaction.options.getBoolean("silent") ?? false;

    const durationMs = parseDuration(durationStr);
    if (!durationMs) {
      return interaction.editReply({
        content: "Invalid duration. Use formats like `30m`, `1h`, `7d`, `2w`.",
      });
    }

    const targetMember = await this.fetchGuildMember(interaction, targetUser.id);
    const actorMember = await this.fetchGuildMember(interaction, interaction.user.id);

    if (targetMember && actorMember && !canPunishMember(actorMember, targetMember)) {
      return interaction.editReply({ embeds: [this.hierarchyErrorEmbed()] });
    }

    const expiresAt = new Date(Date.now() + durationMs);
    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);

    const dmStatus = await sendPunishmentDm(targetUser, {
      type: "TEMP_BAN",
      reason,
      guildName: interaction.guild.name,
      expiresAt,
    });

    try {
      await interaction.guild.members.ban(targetUser.id, {
        reason: `[Punish] ${reason}`,
        deleteMessageSeconds: 0,
      });
    } catch (error) {
      console.error("Failed to ban member:", error);
      return interaction.editReply({
        content: "Failed to ban the user. The bot may lack permissions.",
      });
    }

    const punishmentId = await createPunishment({
      type: "TEMP_BAN",
      targetDiscordUserId: targetUser.id,
      targetDiscordTag: getTargetTag(targetUser),
      targetPlayerId: targetLinked?.userId || null,
      actorDiscordUserId: interaction.user.id,
      actorNameSnapshot: getTargetTag(interaction.user),
      reason,
      expiresAt,
      context: this.buildContext(interaction, evidence),
      dmStatus,
    });

    if (!silent) {
      await sendLogEmbed(interaction.client, {
        type: "TEMP_BAN",
        targetUser,
        actorUser: interaction.user,
        reason,
        expiresAt,
        punishmentId,
        dmStatus,
        silent,
      });
    }

    await sendPunishmentWebhook({
      type: "TEMP_BAN",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: durationMs,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    const unixTs = Math.floor(expiresAt.getTime() / 1000);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User Temporarily Banned")
          .setDescription(
            `<@${targetUser.id}> has been temporarily banned.\n**Reason:** ${reason}\n**Expires:** <t:${unixTs}:F> (<t:${unixTs}:R>)\n**DM Status:** ${dmStatus}\n**Punishment ID:** ${punishmentId}`
          )
          .setColor(Colors.Red)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handlePermBan(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const evidence = interaction.options.getString("evidence");
    const silent = interaction.options.getBoolean("silent") ?? false;

    const targetMember = await this.fetchGuildMember(interaction, targetUser.id);
    const actorMember = await this.fetchGuildMember(interaction, interaction.user.id);

    if (targetMember && actorMember && !canPunishMember(actorMember, targetMember)) {
      return interaction.editReply({ embeds: [this.hierarchyErrorEmbed()] });
    }

    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);

    const dmStatus = await sendPunishmentDm(targetUser, {
      type: "PERM_BAN",
      reason,
      guildName: interaction.guild.name,
      expiresAt: null,
    });

    try {
      await interaction.guild.members.ban(targetUser.id, {
        reason: `[Punish] ${reason}`,
        deleteMessageSeconds: 0,
      });
    } catch (error) {
      console.error("Failed to ban member:", error);
      return interaction.editReply({
        content: "Failed to ban the user. The bot may lack permissions.",
      });
    }

    const punishmentId = await createPunishment({
      type: "PERM_BAN",
      targetDiscordUserId: targetUser.id,
      targetDiscordTag: getTargetTag(targetUser),
      targetPlayerId: targetLinked?.userId || null,
      actorDiscordUserId: interaction.user.id,
      actorNameSnapshot: getTargetTag(interaction.user),
      reason,
      expiresAt: null,
      context: this.buildContext(interaction, evidence),
      dmStatus,
    });

    if (!silent) {
      await sendLogEmbed(interaction.client, {
        type: "PERM_BAN",
        targetUser,
        actorUser: interaction.user,
        reason,
        expiresAt: null,
        punishmentId,
        dmStatus,
        silent,
      });
    }

    await sendPunishmentWebhook({
      type: "PERM_BAN",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: null,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User Permanently Banned")
          .setDescription(
            `<@${targetUser.id}> has been permanently banned.\n**Reason:** ${reason}\n**DM Status:** ${dmStatus}\n**Punishment ID:** ${punishmentId}`
          )
          .setColor(Colors.DarkRed)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handleTempMute(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const durationStr = interaction.options.getString("duration");
    const evidence = interaction.options.getString("evidence");
    const silent = interaction.options.getBoolean("silent") ?? false;

    const durationMs = parseDuration(durationStr);
    if (!durationMs) {
      return interaction.editReply({
        content: "Invalid duration. Use formats like `30m`, `1h`, `7d`, `2w`.",
      });
    }

    const targetMember = await this.fetchGuildMember(interaction, targetUser.id);
    const actorMember = await this.fetchGuildMember(interaction, interaction.user.id);

    if (targetMember && actorMember && !canPunishMember(actorMember, targetMember)) {
      return interaction.editReply({ embeds: [this.hierarchyErrorEmbed()] });
    }

    if (!targetMember) {
      return interaction.editReply({
        content: "That user is not currently in the guild and cannot be muted.",
      });
    }

    if (!MUTED_ROLE_ID) {
      return interaction.editReply({
        content: "Muted role is not configured. Please set `discord.roles.muted` in config.",
      });
    }

    const expiresAt = new Date(Date.now() + durationMs);
    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);

    const dmStatus = await sendPunishmentDm(targetUser, {
      type: "TEMP_MUTE",
      reason,
      guildName: interaction.guild.name,
      expiresAt,
    });

    try {
      await targetMember.roles.add(MUTED_ROLE_ID, `[Punish] ${reason}`);
    } catch (error) {
      console.error("Failed to apply muted role:", error);
      return interaction.editReply({
        content: "Failed to apply the muted role. The bot may lack permissions or the role is misconfigured.",
      });
    }

    const punishmentId = await createPunishment({
      type: "TEMP_MUTE",
      targetDiscordUserId: targetUser.id,
      targetDiscordTag: getTargetTag(targetUser),
      targetPlayerId: targetLinked?.userId || null,
      actorDiscordUserId: interaction.user.id,
      actorNameSnapshot: getTargetTag(interaction.user),
      reason,
      expiresAt,
      context: this.buildContext(interaction, evidence),
      dmStatus,
    });

    if (!silent) {
      await sendLogEmbed(interaction.client, {
        type: "TEMP_MUTE",
        targetUser,
        actorUser: interaction.user,
        reason,
        expiresAt,
        punishmentId,
        dmStatus,
        silent,
      });
    }

    await sendPunishmentWebhook({
      type: "TEMP_MUTE",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: durationMs,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    const unixTs = Math.floor(expiresAt.getTime() / 1000);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User Temporarily Muted")
          .setDescription(
            `<@${targetUser.id}> has been temporarily muted.\n**Reason:** ${reason}\n**Expires:** <t:${unixTs}:F> (<t:${unixTs}:R>)\n**DM Status:** ${dmStatus}\n**Punishment ID:** ${punishmentId}`
          )
          .setColor(Colors.DarkGrey)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handlePermMute(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const evidence = interaction.options.getString("evidence");
    const silent = interaction.options.getBoolean("silent") ?? false;

    const targetMember = await this.fetchGuildMember(interaction, targetUser.id);
    const actorMember = await this.fetchGuildMember(interaction, interaction.user.id);

    if (targetMember && actorMember && !canPunishMember(actorMember, targetMember)) {
      return interaction.editReply({ embeds: [this.hierarchyErrorEmbed()] });
    }

    if (!targetMember) {
      return interaction.editReply({
        content: "That user is not currently in the guild and cannot be muted.",
      });
    }

    if (!MUTED_ROLE_ID) {
      return interaction.editReply({
        content: "Muted role is not configured. Please set `discord.roles.muted` in config.",
      });
    }

    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);

    const dmStatus = await sendPunishmentDm(targetUser, {
      type: "PERM_MUTE",
      reason,
      guildName: interaction.guild.name,
      expiresAt: null,
    });

    try {
      await targetMember.roles.add(MUTED_ROLE_ID, `[Punish] ${reason}`);
    } catch (error) {
      console.error("Failed to apply muted role:", error);
      return interaction.editReply({
        content: "Failed to apply the muted role. The bot may lack permissions or the role is misconfigured.",
      });
    }

    const punishmentId = await createPunishment({
      type: "PERM_MUTE",
      targetDiscordUserId: targetUser.id,
      targetDiscordTag: getTargetTag(targetUser),
      targetPlayerId: targetLinked?.userId || null,
      actorDiscordUserId: interaction.user.id,
      actorNameSnapshot: getTargetTag(interaction.user),
      reason,
      expiresAt: null,
      context: this.buildContext(interaction, evidence),
      dmStatus,
    });

    if (!silent) {
      await sendLogEmbed(interaction.client, {
        type: "PERM_MUTE",
        targetUser,
        actorUser: interaction.user,
        reason,
        expiresAt: null,
        punishmentId,
        dmStatus,
        silent,
      });
    }

    await sendPunishmentWebhook({
      type: "PERM_MUTE",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: null,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User Permanently Muted")
          .setDescription(
            `<@${targetUser.id}> has been permanently muted.\n**Reason:** ${reason}\n**DM Status:** ${dmStatus}\n**Punishment ID:** ${punishmentId}`
          )
          .setColor(Colors.DarkGrey)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handleUnban(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);

    // Find active ban punishments for this user
    const activeBans = await getActivePunishments(targetUser.id);
    const banRecords = activeBans.filter(
      (p) => p.type === "TEMP_BAN" || p.type === "PERM_BAN"
    );

    try {
      await interaction.guild.members.unban(targetUser.id, `[Punish] ${reason}`);
    } catch (error) {
      // User may not actually be banned in Discord
      console.warn("Failed to unban (may not be banned):", error.message);
    }

    // Lift all active ban records
    for (const ban of banRecords) {
      await liftPunishment(ban.id);
    }

    if (LOG_CHANNEL_ID) {
      try {
        const channel = await interaction.client.channels.fetch(LOG_CHANNEL_ID);
        if (channel?.isTextBased?.()) {
          const embed = new EmbedBuilder()
            .setTitle("User Unbanned")
            .setDescription(
              `<@${targetUser.id}> has been unbanned by <@${interaction.user.id}>.\n**Reason:** ${reason}`
            )
            .setColor(Colors.Green)
            .setTimestamp(new Date());
          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error("Failed to send unban log:", err);
      }
    }

    await sendPunishmentWebhook({
      type: "UNBAN",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: null,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User Unbanned")
          .setDescription(
            `<@${targetUser.id}> has been unbanned.\n**Reason:** ${reason}\n**Records lifted:** ${banRecords.length}`
          )
          .setColor(Colors.Green)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handleUnmute(interaction, actorLinked) {
    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const targetLinked = await new UserGetter().byDiscordId(targetUser.id);

    const targetMember = await this.fetchGuildMember(interaction, targetUser.id);

    if (targetMember && MUTED_ROLE_ID) {
      try {
        await targetMember.roles.remove(MUTED_ROLE_ID, `[Punish] ${reason}`);
      } catch (error) {
        console.warn("Failed to remove muted role:", error.message);
      }
    }

    const activeMutes = await getActivePunishments(targetUser.id);
    const muteRecords = activeMutes.filter(
      (p) => p.type === "TEMP_MUTE" || p.type === "PERM_MUTE"
    );

    for (const mute of muteRecords) {
      await liftPunishment(mute.id);
    }

    if (LOG_CHANNEL_ID) {
      try {
        const channel = await interaction.client.channels.fetch(LOG_CHANNEL_ID);
        if (channel?.isTextBased?.()) {
          const embed = new EmbedBuilder()
            .setTitle("User Unmuted")
            .setDescription(
              `<@${targetUser.id}> has been unmuted by <@${interaction.user.id}>.\n**Reason:** ${reason}`
            )
            .setColor(Colors.Green)
            .setTimestamp(new Date());
          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error("Failed to send unmute log:", err);
      }
    }

    await sendPunishmentWebhook({
      type: "UNMUTE",
      targetTag: getTargetTag(targetUser),
      actorTag: getTargetTag(interaction.user),
      reason,
      durationMs: null,
      punishmentLink: targetLinked?.username
        ? `${process.env.siteAddress}/profile/${targetLinked.username}`
        : undefined,
    });

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User Unmuted")
          .setDescription(
            `<@${targetUser.id}> has been unmuted.\n**Reason:** ${reason}\n**Records lifted:** ${muteRecords.length}`
          )
          .setColor(Colors.Green)
          .setTimestamp(new Date()),
      ],
    });
  }

  async handleHistory(interaction) {
    const targetUser = interaction.options.getUser("user");
    const username = interaction.options.getString("username");
    const discordTag = interaction.options.getString("discord_tag");

    if (!targetUser && !username && !discordTag) {
      return interaction.editReply({
        content: "Please provide a Discord user, Minecraft username, or Discord tag to look up.",
      });
    }

    // Resolve target Discord ID
    let targetDiscordId = targetUser?.id;
    if (!targetDiscordId && discordTag) {
      targetDiscordId = await resolveDiscordUserId(interaction, {
        discordTag,
      });
      if (!targetDiscordId) {
        return interaction.editReply({
          content: "Unable to resolve the provided Discord information to a user.",
        });
      }
    }

    // Look up linked profile (for MC punishments + display name).
    // Queried in-process (same as the web profile page) instead of an HTTP
    // self-call, which is unreliable when the bot's outbound request to its
    // own siteAddress can't complete (DNS/WAF/network hairpinning).
    let profileData = null;
    const userGetterForHistory = new UserGetter();

    try {
      if (username) {
        profileData = await userGetterForHistory.byUsername(username);
      } else if (targetDiscordId) {
        profileData = await userGetterForHistory.byDiscordId(targetDiscordId);
      }
      if (profileData && !targetDiscordId && profileData.discordId) {
        targetDiscordId = profileData.discordId;
      }
    } catch (err) {
      console.error("Failed to fetch profile for punishment history:", err);
    }

    // Fetch Discord punishments
    let discordPunishments = [];
    if (targetDiscordId) {
      try {
        discordPunishments = await getPunishmentHistory(targetDiscordId, MAX_HISTORY_PUNISHMENTS);
      } catch (err) {
        console.error("Failed to fetch Discord punishments for history:", err);
      }
    }

    // Fetch Minecraft punishments directly from the punishments DB
    let mcPunishments = [];
    if (profileData?.username) {
      try {
        const result = await getUserPunishments(profileData.username);
        if (result?.success && Array.isArray(result.data)) {
          mcPunishments = result.data;
        }
      } catch (err) {
        console.error("Failed to fetch MC punishments for history:", err);
      }
    }

    if (!discordPunishments.length && !mcPunishments.length) {
      const displayName = targetUser
        ? getTargetTag(targetUser)
        : profileData?.username || username || discordTag || "the specified user";
      return interaction.editReply({
        content: `${displayName} has no punishment records.`,
      });
    }

    // Combine punishments from both platforms, sorted by date (newest first)
    const combined = [
      ...mcPunishments.map((p) => ({
        ...p,
        _platform: "Minecraft",
        _sortDate: p.dateStart ? new Date(p.dateStart) : new Date(0),
      })),
      ...discordPunishments.map((p) => ({
        ...p,
        _platform: "Discord",
        _sortDate: p.created_at ? new Date(p.created_at) : new Date(0),
      })),
    ].sort((a, b) => b._sortDate - a._sortDate);

    const limited = combined.slice(0, MAX_HISTORY_PUNISHMENTS);
    const truncated = limited.length < combined.length;
    const totalCount = combined.length;
    const totalPages = Math.max(1, Math.ceil(limited.length / HISTORY_PER_PAGE));

    const displayName = targetUser
      ? getTargetTag(targetUser)
      : profileData?.username || username || discordTag || "the specified user";

    let currentPage = 0;

    const initialEmbed = buildHistoryEmbed({
      displayName,
      profileData,
      punishments: limited,
      totalCount,
      truncated,
      page: currentPage,
    });

    const initialComponents = buildHistoryPaginationComponents(currentPage, totalPages);

    await interaction.editReply({
      embeds: [initialEmbed],
      components: initialComponents,
    });

    if (totalPages <= 1) return;

    let replyMessage;
    try {
      replyMessage = await interaction.fetchReply();
    } catch (error) {
      console.error("Failed to fetch history reply message:", error);
      return;
    }

    if (!replyMessage || typeof replyMessage.createMessageComponentCollector !== "function") return;

    const collector = replyMessage.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: HISTORY_PAGINATION_TIMEOUT_MS,
      filter: (ci) => {
        if (ci.user.id !== interaction.user.id) return false;
        if (ci.customId !== HISTORY_CUSTOM_IDS.previous && ci.customId !== HISTORY_CUSTOM_IDS.next) return false;
        return ci.message?.interaction?.id === interaction.id;
      },
    });

    collector.on("collect", async (ci) => {
      try {
        if (ci.customId === HISTORY_CUSTOM_IDS.previous && currentPage > 0) {
          currentPage -= 1;
        } else if (ci.customId === HISTORY_CUSTOM_IDS.next && currentPage < totalPages - 1) {
          currentPage += 1;
        } else {
          await ci.deferUpdate();
          return;
        }

        const updatedEmbed = buildHistoryEmbed({
          displayName,
          profileData,
          punishments: limited,
          totalCount,
          truncated,
          page: currentPage,
        });
        const updatedComponents = buildHistoryPaginationComponents(currentPage, totalPages);
        await ci.update({ embeds: [updatedEmbed], components: updatedComponents });
      } catch (error) {
        console.error("Failed to update history pagination:", error);
        try { await ci.deferUpdate(); } catch (e) { /* ignore */ }
      }
    });

    collector.on("end", async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch (error) {
        console.error("Failed to clear history pagination components:", error);
      }
    });
  }

  async fetchGuildMember(interaction, userId) {
    try {
      return await interaction.guild.members.fetch(userId);
    } catch {
      return null;
    }
  }

  buildContext(interaction, evidence) {
    const ctx = {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
    };

    if (evidence) {
      ctx.evidence = evidence;
    }

    return ctx;
  }

  hierarchyErrorEmbed() {
    return new EmbedBuilder()
      .setTitle("Cannot Punish User")
      .setDescription(
        "You cannot punish this user because they have an equal or higher role than you."
      )
      .setColor(Colors.Red);
  }
}
