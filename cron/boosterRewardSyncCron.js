/**
 * cron/boosterRewardSyncCron.js
 *
 * Booster rewards sweep: every 30 minutes (and shortly after start-up), make
 * the granted ranks match who is boosting the Discord server right now. Catches
 * what the live listener cannot see: members who left the server, boosts that
 * ended while the bot was offline, and changes to the configured rank list.
 * Turning the feature off in Settings revokes every grant on the next sweep.
 *
 * Gating is inside syncBoosterRewards (settings must have loaded from the
 * database, so an outage never revokes on the built-in defaults).
 */

import cron from "node-cron";
import { createRequire } from "module";
import { client } from "../controllers/discordController.js";
import { syncBoosterRewards } from "../controllers/boosterRewardController.js";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");

let running = false;

async function sweep() {
  if (running) return;
  const guildId = config.discord?.guildId;
  if (!guildId || !client?.isReady?.()) return;

  running = true;
  try {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return;

    // rankDiscordRoleSyncCron fetches the full member list every 15 minutes
    // (:00/:15/:30/:45) and the live boost listeners keep premiumSince current,
    // so the member cache is almost always warm by the time this sweep runs
    // (:07/:37). Reuse it instead of issuing our own gateway member fetch — a
    // second opcode-8 request is exactly what Discord was rate-limiting
    // ("Request with opcode 8 was rate limited ... skipping this sweep"). Only
    // pay for a full fetch when the cache is genuinely cold (e.g. fresh boot,
    // where only the bot itself is cached).
    if (guild.members.cache.size <= 1) {
      try {
        await guild.members.fetch({ time: 120_000 });
      } catch (error) {
        // Without the full member list, "not boosting" cannot be told apart
        // from "not fetched" -- skip rather than revoke.
        console.warn(`[boosterRewards] Could not fetch guild members (${error?.message || error}); skipping this sweep.`);
        return;
      }
    }

    const boosters = new Set();
    for (const [, member] of guild.members.cache) {
      if (member.premiumSince && !member.user.bot) boosters.add(member.id);
    }

    await syncBoosterRewards({ boosterDiscordIds: boosters });
  } catch (error) {
    console.error("[boosterRewards] Sweep failed:", error.message);
  } finally {
    running = false;
  }
}

// :07 and :37 -- offset from cron/rankDiscordRoleSyncCron.js (:00/:15/:30/:45),
// which also fetches the full member list. Discord rate-limits a second
// member-list request made at the same moment (gateway opcode 8).
cron.schedule("7,37 * * * *", sweep);

// Once shortly after start-up, when the Discord client has had time to log in.
setTimeout(sweep, 90_000).unref?.();
