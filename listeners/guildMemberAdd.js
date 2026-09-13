import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");
import { checkAndReportNickname } from "../lib/discord/nicknameCheck.mjs";
import { syncMemberRankRoles } from "../lib/discord/rankRoleSync.mjs";
import { UserGetter } from "../controllers/userController.js";

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
      }
    } catch (error) {
      console.error("[guildMemberAdd] Failed to sync rank roles for rejoining member:", error.message);
    }

    if (!features.discord?.events?.nicknameCheck) return;

    const reportChannelId = config.discord?.nicknameReportChannelId;
    if (!reportChannelId) return;

    // Only enforce if they already have a linked account (e.g. re-joiners)
    await checkAndReportNickname(member, reportChannelId, "Member Joined");
  }
}
