/**
 * listeners/discordActivity.js
 *
 * Counts guild messages per user per day, for the "consistent community
 * activity" form requirement.
 *
 * Only a count is kept -- no content, no per-message timestamp, no channel.
 * See controllers/discordActivityController.js and migration
 * 0050_discord_activity_daily for why.
 *
 * Deliberately NOT gated on features.forms. A form that asks for 30 days of
 * Discord activity is useless if counting only started when someone first
 * ticked the box, so the data has to accumulate whether or not anything is
 * currently reading it. Its own flag (features.discord.activityTracking) turns
 * it off, and defaults to on when the key is absent for the same reason.
 */

import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { activityDateKey, addMessageCounts } from "../controllers/discordActivityController.js";
import { createActivityBuffer } from "../lib/discordActivityBuffer.mjs";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

/** Absent means on: activity must accumulate before anyone asks for it. */
const ENABLED = features?.discord?.activityTracking !== false;

const buffer = createActivityBuffer({
  write: addMessageCounts,
  dateKey: activityDateKey,
});

export class DiscordActivityListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageCreate",
    });

    if (ENABLED) buffer.start();
  }

  async run(message) {
    if (!ENABLED) return;

    // Bots would swamp the counts, and a bot cannot apply for anything.
    if (message.author?.bot) return;

    // DMs and other guilds are out of scope: "active in the community" means
    // active in ours, and a DM is not something this should be able to see.
    if (!message.guildId) return;
    if (config?.discord?.guildId && message.guildId !== config.discord.guildId) return;

    try {
      buffer.record(message.author.id, message.createdAt ?? new Date());
    } catch (error) {
      console.error("[discordActivity] Failed to record message:", error.message);
    }
  }
}
