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

// ---------------------------------------------------------------------------
// Flood guards for the verification welcome.
//
// The welcome fires when a member *gains* the verified role. That is fine for a
// genuine one-off verification, but a bulk role assignment — e.g. setting the
// Linked account role to the same role as the Verified role, which then syncs
// onto every already-linked member at once — would otherwise post one welcome
// per member and spam the channel.
//
// Two in-memory guards (reset on restart, which is fine — a restart won't line
// up with a bulk sync):
//   1. Per-member dedupe: never re-welcome the same member within an hour, so a
//      role being removed and re-added doesn't re-announce them.
//   2. Burst guard: if several welcomes would fire within a few seconds, treat
//      it as a bulk sync rather than individual verifications and stop sending.
// ---------------------------------------------------------------------------
const WELCOME_DEDUPE_MS = 60 * 60 * 1000; // 1 hour
const BURST_WINDOW_MS = 15 * 1000; // 15 seconds
const BURST_MAX = 5; // more than this within the window => bulk sync, suppress
const lastWelcomePerMember = new Map(); // memberId -> last welcome time (ms)
const recentWelcomeTimes = []; // sliding window of recent welcome timestamps (ms)

/** Decide whether to send a welcome now, recording it when allowed. */
function shouldWelcome(memberId) {
  const now = Date.now();

  const last = lastWelcomePerMember.get(memberId);
  if (last && now - last < WELCOME_DEDUPE_MS) return false;

  while (recentWelcomeTimes.length && now - recentWelcomeTimes[0] > BURST_WINDOW_MS) {
    recentWelcomeTimes.shift();
  }
  if (recentWelcomeTimes.length >= BURST_MAX) return false;

  recentWelcomeTimes.push(now);
  lastWelcomePerMember.set(memberId, now);
  return true;
}

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

      if (!oldRole && newRole) {
        // Suppress bulk/sync-driven assignments so the channel is never spammed.
        if (!shouldWelcome(newMember.id)) {
          console.warn(
            `[guildMemberUpdate] Suppressed verify welcome for ${newMember.user.username} ` +
              `(${newMember.id}) — looks like a bulk role sync or a repeat, not an individual verification.`
          );
          return;
        }

        const welcomeHook = new Webhook(config.discord.webhooks.welcome);

        // Grab random letters and numbers to get a HEX Colour.
        const randomColor = Math.floor(Math.random() * 16777215).toString(16);

        // Select a random join message from joinMessages.json
        const randomJoinMessage =
          joinMessages[Math.floor(Math.random() * joinMessages.length)];

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
