/*
 * Delete orphaned ticket channels — Discord channels named `ticket-<n>` or
 * `ticket-pending` that have no matching `supportTickets.discordChannelId` row.
 *
 * This is the same logic the bot runs on startup
 * (cleanupOrphanTicketChannels in controllers/supportTicketController.js),
 * exposed as a one-off so you don't have to wait for a redeploy/restart.
 *
 * IMPORTANT: the bot can only delete channels it can actually see and manage.
 * If a channel reports "Missing Access" (50001) / "Missing Permissions" (50013),
 * grant the bot **View Channel + Manage Channels** on the ticket category (or
 * Administrator at the guild level), then re-run. There is no way around a
 * Discord permission check from a script.
 *
 * Usage:
 *   node scripts/cleanupOrphanTicketChannels.mjs                 # auto-detect & delete orphans
 *   node scripts/cleanupOrphanTicketChannels.mjs --dry-run       # report only, delete nothing
 *   node scripts/cleanupOrphanTicketChannels.mjs 123 456 789     # force-delete these channel IDs
 *   node scripts/cleanupOrphanTicketChannels.mjs --dry-run 123   # report what would happen for 123
 */
import dotenv from "dotenv";
dotenv.config();

import { Client, GatewayIntentBits } from "discord.js";
import { cleanupOrphanTicketChannels } from "../controllers/supportTicketController.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const explicitIds = args.filter((a) => /^\d{5,}$/.test(a));

const token = process.env.discordAPIKey;
if (!token) {
  console.error("[cleanup-orphans] discordAPIKey is not set in .env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function forceDelete(ids) {
  let deleted = 0;
  const blocked = [];
  for (const id of ids) {
    let channel;
    try {
      channel = await client.channels.fetch(id);
    } catch (error) {
      if (error?.code === 10003 /* Unknown Channel */) {
        console.log(`[cleanup-orphans] ${id}: already gone`);
        continue;
      }
      if (error?.code === 50001) {
        blocked.push(id);
        console.warn(`[cleanup-orphans] ${id}: Missing Access — cannot even see this channel`);
        continue;
      }
      console.error(`[cleanup-orphans] ${id}: fetch failed`, error?.message || error);
      continue;
    }

    const label = `${channel.name} (${id})`;
    if (DRY_RUN) {
      console.log(`[cleanup-orphans] would delete ${label}`);
      continue;
    }

    try {
      await channel.delete("Manual orphan ticket channel cleanup");
      deleted += 1;
      console.log(`[cleanup-orphans] deleted ${label}`);
    } catch (error) {
      if (error?.code === 50001 || error?.code === 50013) {
        blocked.push(id);
        console.warn(
          `[cleanup-orphans] ${label}: ${error.code === 50001 ? "Missing Access" : "Missing Permissions"} — grant the bot View Channel + Manage Channels (or Administrator) and re-run`
        );
      } else {
        console.error(`[cleanup-orphans] ${label}: delete failed`, error?.message || error);
      }
    }
  }
  return { deleted, blocked };
}

client.once("ready", async () => {
  console.log(
    `[cleanup-orphans] logged in as ${client.user.tag}${DRY_RUN ? " (DRY RUN)" : ""}`
  );

  try {
    if (explicitIds.length) {
      console.log(`[cleanup-orphans] force mode: ${explicitIds.length} channel id(s)`);
      const { deleted, blocked } = await forceDelete(explicitIds);
      console.log(
        `[cleanup-orphans] done. deleted=${deleted} blocked=${blocked.length}` +
          (blocked.length ? ` -> ${blocked.join(", ")}` : "")
      );
    } else {
      // minAgeMinutes: 0 — a script run is deliberate, no in-flight create to race.
      const result = await cleanupOrphanTicketChannels(client, {
        minAgeMinutes: 0,
        dryRun: DRY_RUN,
      });
      console.log("[cleanup-orphans] done.", result);
    }
  } catch (error) {
    console.error("[cleanup-orphans] fatal:", error);
    process.exitCode = 1;
  } finally {
    await client.destroy();
    process.exit(process.exitCode || 0);
  }
});

client.login(token);
