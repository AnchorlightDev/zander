import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");
import { checkAndReportNickname } from "../lib/discord/nicknameCheck.mjs";
import { syncMemberRankRoles } from "../lib/discord/rankRoleSync.mjs";
import { syncLinkedRoleForDiscordId } from "../lib/discord/linkedRoleSync.mjs";
import { UserGetter } from "../controllers/userController.js";
import { hasOtherEnforcedPunishment } from "../controllers/discordPunishmentController.js";

export class GuildMemberAddListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "guildMemberAdd",
    });
  }

  async run(member) {
    if (member.user.bot) return;

    // Re-apply rank roles for returning linked members — Discord doesn't
    // remember role state after a member leaves the server.
    try {
      const linkedAccount = await new UserGetter().byDiscordId(member.user.id);
      if (linkedAccount) {
        await syncMemberRankRoles(linkedAccount.userId);
        await syncLinkedRoleForDiscordId(member.user.id);
      }
    } catch (error) {
      console.error("[guildMemberAdd] Failed to sync rank roles for rejoining member:", error.message);
    }

    // Mutes are a role, which Discord drops when a member leaves, so leaving
    // and rejoining would otherwise shed an active mute.
    const mutedRoleId = config.discord?.roles?.muted;
    const guildId = config.discord?.guildId;
    if (mutedRoleId && (!guildId || member.guild?.id === guildId)) {
      try {
        if (await hasOtherEnforcedPunishment(member.user.id, ["TEMP_MUTE", "PERM_MUTE"], 0)) {
          await member.roles.add(mutedRoleId, "[Punish] Reapplying active mute on rejoin");
        }
      } catch (error) {
        console.error("[guildMemberAdd] Failed to reapply muted role:", error.message);
      }
    }

    if (!features.discord?.events?.nicknameCheck) return;

    const reportChannelId = config.discord?.nicknameReportChannelId;
    if (!reportChannelId) return;

    // Only enforce if they already have a linked account (e.g. re-joiners)
    await checkAndReportNickname(member, reportChannelId, "Member Joined");
  }
}
