import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");
import { checkAndReportNickname } from "../lib/discord/nicknameCheck.mjs";

export class NicknameCheckListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "guildMemberUpdate",
    });
  }

  async run(oldMember, newMember) {
    if (!features.discord.events.nicknameCheck) return;
    if (!newMember.guild) return;
    if (newMember.user.bot) return;

    // Check if the member's display name changed (nickname or global name)
    const oldDisplayName = oldMember.nickname || oldMember.user.globalName || oldMember.user.username;
    const newDisplayName = newMember.nickname || newMember.user.globalName || newMember.user.username;

    if (oldDisplayName === newDisplayName) return;

    const reportChannelId = config.discord.nicknameReportChannelId;
    if (!reportChannelId) return;

    await checkAndReportNickname(newMember, reportChannelId, "Nickname Change");
  }
}
