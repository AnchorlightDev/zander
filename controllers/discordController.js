import { SapphireClient, ApplicationCommandRegistries, RegisterBehavior } from "@sapphire/framework";
import { GatewayIntentBits, Partials } from "discord.js";

// Use BulkOverwrite instead of the default per-command Overwrite.
// The default behavior makes one Discord API call per command on every startup
// (20+ commands = 20+ sequential HTTP round-trips), which congests the event
// loop long enough for incoming interaction tokens to expire before the handler
// can call deferReply, causing "application did not respond" errors.
// BulkOverwrite replaces all of that with a single PUT call.
ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

//
// Discord
//
export const client = new SapphireClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
    // Forum bridge: reactions in bridged Discord forum channels sync to the website.
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Forum bridge: edits, deletes and reactions on messages sent before the
  // bot's last restart arrive as partials; without these they are dropped.
  partials: [Partials.Message, Partials.Reaction, Partials.User],
  presence: {
    status: "online",
    activities: [
      {
        name: process.env.siteAddress,
        type: "PLAYING",
      },
    ],
  },
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.once("ready", async () => {
  try {
    const { cleanupOrphanTicketChannels } = await import("./supportTicketController.js");
    await cleanupOrphanTicketChannels(client);
  } catch (error) {
    console.error("Startup orphan ticket channel sweep failed:", error);
  }

  // Forum bridge: pick up Discord forum posts made while the bot was offline,
  // then flush anything the website queued for Discord meanwhile.
  try {
    const { catchUpBridgedChannels } = await import("../lib/forums/forumBridgeDiscord.mjs");
    await catchUpBridgedChannels(client);
    const { processForumOutbox } = await import("../lib/forums/forumBridgeSync.mjs");
    await processForumOutbox();
  } catch (error) {
    console.error("Forum bridge startup catch-up failed:", error);
  }
});

client.on("shardError", (error) => {
  // Transient Discord gateway hiccup (e.g. HTTP 503 on connect). discord.js
  // reconnects automatically — warn, don't page. Fatal cases surface via
  // 'error' / 'shardDisconnect' / 'invalidated' instead.
  console.warn("Discord gateway shard error (auto-reconnecting):", error?.message || error);
});

client.login(process.env.discordAPIKey);

