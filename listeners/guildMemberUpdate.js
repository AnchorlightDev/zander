import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const joinMessages = require("../joinMessages.json");
const config = require("../lib/config/config.cjs");
import { EmbedBuilder } from "discord.js";
const features = require("../lib/config/features.cjs");
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";
import { checkAndReportNickname } from "../lib/discord/nicknameCheck.mjs";

export class GuildMemberUpdateListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "guildMemberUpdate",
    });
  }

  async run(oldMember, newMember) {
    if (!newMember.guild) return;
    if (newMember.user.bot) return;

    if (features.discord.events.guildMemberVerify) {
      const oldRole = oldMember.roles.cache.has(config.discord.roles.verified);
      const newRole = newMember.roles.cache.has(config.discord.roles.verified);

      const welcomeHook = new Webhook(config.discord.webhooks.welcome);

      // Grab random letters and numbers to get a HEX Colour.
      const randomColor = Math.floor(Math.random() * 16777215).toString(16);

      // Select a random join message from joinMessages.json
      const randomJoinMessage =
        joinMessages[Math.floor(Math.random() * joinMessages.length)];

      if (!oldRole && newRole) {
        let embed = new MessageBuilder()
          .setTitle(
            randomJoinMessage.replace("%USERNAME%", newMember.user.username)
          )
          .setColor(`#${randomColor}`);
        await sendWebhookMessage(welcomeHook, embed, {
          context: "listeners/guildMemberUpdate",
        });

        // Check nickname when a member gets verified
        if (features.discord.events.nicknameCheck && config.discord.nicknameReportChannelId) {
          await checkAndReportNickname(newMember, config.discord.nicknameReportChannelId, "Account Linked");
        }
      }
    }
  }
}
