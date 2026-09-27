import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
import { Colors, EmbedBuilder } from "discord.js";
const features = require("../lib/config/features.cjs");
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";

export class GuildMemberBoostUpdateListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "guildMemberUpdate",
    });
  }

  async run(oldMember, newMember) {
    if (features.discord.events.guildMemberBoost) {
      if (!newMember.guild) return;
      if (newMember.user.bot) return;

      const oldStatus = oldMember.premiumSince;
      const newStatus = newMember.premiumSince;

      const welcomeHook = new Webhook(config.discord.webhooks.welcome);

      if (!oldStatus && newStatus) {
        let embed = new MessageBuilder()
          .setTitle(
            `\`${newMember.user.username}\` has boosted the Server! :tada:`
          )
          .setColor(Colors.DarkVividPink);
        await sendWebhookMessage(welcomeHook, embed, {
          context: "listeners/guildMemberBoostUpdate",
        });
      }
      return;
    }
  }
}
