import { Listener } from "@sapphire/framework";
import { AuditLogEvent } from "discord.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
import {
  createPunishment,
  hasActivePunishment,
} from "../controllers/discordPunishmentController.js";
import { UserGetter } from "../controllers/userController.js";
import { sendPunishmentWebhook, getTargetTag } from "../commands/punish.mjs";

export class GuildBanAddListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "guildBanAdd",
    });
  }

  async run(ban) {
    // Skip if the bot itself is banning (already handled by /punish command)
    // We check the audit log to determine if this was done via native Discord UI
    try {
      // Small delay to let the audit log entry populate
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const auditLogs = await ban.guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanAdd,
        limit: 5,
      });

      const entry = auditLogs.entries.find(
        (e) =>
          e.target?.id === ban.user.id &&
          Date.now() - e.createdTimestamp < 10000
      );

      // If the executor is the bot itself, the /punish command already handled it
      if (entry?.executor?.id === ban.guild.members.me?.id) return;

      // This is a native Discord ban (via right-click > Ban Member, or another bot)
      const executorTag = entry?.executor
        ? getTargetTag(entry.executor)
        : "Unknown";
      const executorId = entry?.executor?.id || "0";
      const reason = entry?.reason || ban.reason || "No reason provided";

      // Check if we already have an active ban record to avoid duplicates
      const alreadyTracked = await hasActivePunishment(ban.user.id, "PERM_BAN");
      const alreadyTrackedTemp = await hasActivePunishment(ban.user.id, "TEMP_BAN");
      if (alreadyTracked || alreadyTrackedTemp) return;

      // Look up linked player account
      const targetLinked = await new UserGetter().byDiscordId(ban.user.id);

      await createPunishment({
        type: "PERM_BAN",
        targetDiscordUserId: ban.user.id,
        targetDiscordTag: getTargetTag(ban.user),
        targetPlayerId: targetLinked?.userId || null,
        actorDiscordUserId: executorId,
        actorNameSnapshot: executorTag,
        reason,
        expiresAt: null,
        context: { source: "native_discord_ban" },
        dmStatus: "NOT_APPLICABLE",
      });

      await sendPunishmentWebhook({
        type: "NATIVE_BAN",
        targetTag: getTargetTag(ban.user),
        actorTag: executorTag,
        reason,
        durationMs: null,
        punishmentLink: targetLinked?.username
          ? `${process.env.siteAddress}/profile/${targetLinked.username}`
          : undefined,
      });
    } catch (error) {
      console.error("[Punishments] Failed to process native guildBanAdd:", error);
    }
  }
}
