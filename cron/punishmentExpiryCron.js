import cron from "node-cron";
import { createRequire } from "module";
import { client } from "../controllers/discordController.js";
import {
  getExpiredActivePunishments,
  expirePunishment,
  getAllActivePunishments,
} from "../controllers/discordPunishmentController.js";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");

const GUILD_ID = config.discord?.guildId;
const MUTED_ROLE_ID = config.discord?.roles?.muted;

/**
 * Lift an expired punishment in Discord.
 */
async function liftInDiscord(punishment) {
  if (!client?.isReady?.() || !GUILD_ID) return;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) return;

    if (punishment.type === "TEMP_BAN") {
      try {
        await guild.members.unban(
          punishment.target_discord_user_id,
          "[Auto] Temporary ban expired"
        );
      } catch (error) {
        // User may already be unbanned
        if (error.code !== 10026) {
          console.warn("punishmentExpiryCron: failed to unban", punishment.id, error.message);
        }
      }
    }

    if (punishment.type === "TEMP_MUTE" && MUTED_ROLE_ID) {
      try {
        const member = await guild.members.fetch(punishment.target_discord_user_id);
        if (member) {
          await member.roles.remove(MUTED_ROLE_ID, "[Auto] Temporary mute expired");
        }
      } catch (error) {
        // Member may have left the guild
        if (error.code !== 10007) {
          console.warn("punishmentExpiryCron: failed to unmute", punishment.id, error.message);
        }
      }
    }
  } catch (error) {
    console.error("punishmentExpiryCron: guild fetch failed", error);
  }
}

// Run every 30 seconds to check for expired punishments
const punishmentExpiryTask = cron.schedule("*/1 * * * *", async () => {
  if (!client?.isReady?.()) return;

  try {
    const expired = await getExpiredActivePunishments();

    for (const punishment of expired) {
      try {
        await liftInDiscord(punishment);
        await expirePunishment(punishment.id);
      } catch (error) {
        console.error(
          `punishmentExpiryCron: failed to expire punishment ${punishment.id}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error("punishmentExpiryCron: query failed", error);
  }
});

punishmentExpiryTask.start();

/**
 * Startup reconciliation: ensure active punishments are enforced.
 * Called once when the bot becomes ready.
 */
export async function reconcileActivePunishments() {
  if (!client?.isReady?.() || !GUILD_ID) return;

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) return;

    const activePunishments = await getAllActivePunishments();

    // First expire any that should have expired while bot was down
    const now = new Date();
    for (const p of activePunishments) {
      if (p.expires_at && new Date(p.expires_at) <= now) {
        await liftInDiscord(p);
        await expirePunishment(p.id);
        continue;
      }

      // For active mutes, make sure the muted role is applied
      if ((p.type === "TEMP_MUTE" || p.type === "PERM_MUTE") && MUTED_ROLE_ID) {
        try {
          const member = await guild.members.fetch(p.target_discord_user_id);
          if (member && !member.roles.cache.has(MUTED_ROLE_ID)) {
            await member.roles.add(MUTED_ROLE_ID, "[Reconciliation] Reapplying active mute");
          }
        } catch {
          // Member may not be in the guild
        }
      }
    }

    console.log(
      `[Punishments] Reconciliation complete: ${activePunishments.length} active punishments checked.`
    );
  } catch (error) {
    console.error("[Punishments] Reconciliation failed:", error);
  }
}
