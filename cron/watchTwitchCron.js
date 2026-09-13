/**
 * Twitch live-stream sync cron.
 *
 * Runs every 5 minutes. For each eligible creator with an active Twitch connection:
 *   - Fetches current stream data from the Twitch Helix API (app access token)
 *   - Applies CFC content filters
 *   - Upserts eligible streams into creator_content_items
 *   - Marks streams that ended as offline
 *   - Sends a one-time Discord notification when a creator first goes live
 */

import cron from "node-cron";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { client } from "../controllers/discordController.js";
import {
  getEligibleCreators,
  matchesCfcFilter,
  upsertContentItem,
  markStreamsOffline,
  updateSyncStatus,
  hasNotificationBeenSent,
  recordNotification,
  createInGameAnnouncement,
} from "../controllers/watchController.js";

// ---------------------------------------------------------------------------
// Twitch App Access Token (Client Credentials)
// ---------------------------------------------------------------------------

let cachedAppToken = null;
let tokenExpiresAt = 0;

async function getTwitchAppToken(fetchFn) {
  if (cachedAppToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAppToken;
  }

  if (!process.env.twitchClientId || !process.env.twitchClientSecret) {
    return null;
  }

  try {
    const res = await fetchFn("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_id=${encodeURIComponent(process.env.twitchClientId)}&client_secret=${encodeURIComponent(process.env.twitchClientSecret)}&grant_type=client_credentials`,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[WatchTwitch] Failed to obtain app access token (${res.status}):`, body);
      return null;
    }

    const data = await res.json();
    cachedAppToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return cachedAppToken;
  } catch (err) {
    console.error("[WatchTwitch] Error fetching app access token:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discord notification helper
// ---------------------------------------------------------------------------

async function sendLiveNotification(item) {
  const channelId = config?.watch?.contentChannelId;
  if (!channelId) {
    console.warn("[WatchTwitch] contentChannelId is not set in config.json — skipping Discord notification.");
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.warn(`[WatchTwitch] Discord channel "${channelId}" not found — skipping notification.`);
      return null;
    }

    const embed = new EmbedBuilder()
      .setColor(0x9146FF)
      .setTitle(`${item.platform_display_name || item.username} is live on Twitch!`)
      .setDescription(item.title || "")
      .setTimestamp();

    if (item.thumbnail_url) embed.setImage(item.thumbnail_url);

    const siteWatchUrl = process.env.siteAddress ? `${process.env.siteAddress}/watch` : null;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Watch")
        .setStyle(ButtonStyle.Link)
        .setURL(item.watch_url)
        .setEmoji("▶️"),
      ...(siteWatchUrl ? [
        new ButtonBuilder()
          .setLabel("Watch More")
          .setStyle(ButtonStyle.Link)
          .setURL(siteWatchUrl)
          .setEmoji("📺"),
      ] : [])
    );

    const pingRole = config?.watch?.contentPingRoleId;
    const content = pingRole ? `<@&${pingRole}>` : undefined;

    const msg = await channel.send({ content, embeds: [embed], components: [buttons] });
    return msg?.id || "sent";
  } catch (err) {
    console.error("[WatchTwitch] Discord notification failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sync logic — accepts the already-fetched stream object to avoid a
// redundant API call from the outer cron loop.
// stream is null when the creator is currently offline.
// ---------------------------------------------------------------------------

async function syncTwitchCreator(creator, stream) {
  const broadcasterId = creator.platform_account_id;

  try {
    if (!stream) {
      // Creator is offline — outer loop handles markStreamsOffline
      await updateSyncStatus(creator.user_id, "twitch", { success: true });
      return;
    }

    const tags = Array.isArray(stream.tags) ? stream.tags : [];
    const matchedRule = matchesCfcFilter(
      "twitch",
      { title: stream.title, description: "", tags },
      config
    );

    const isCfc = Boolean(matchedRule);
    const isPublic = isCfc; // only CFC-tagged streams are publicly visible

    const thumbnailUrl = stream.thumbnail_url
      ? stream.thumbnail_url.replace("{width}", "640").replace("{height}", "360")
      : null;

    const contentItem = {
      user_id: creator.user_id,
      platform: "twitch",
      external_content_id: stream.id,
      external_channel_id: broadcasterId,
      content_type: "live_stream",
      title: stream.title,
      description: null,
      thumbnail_url: thumbnailUrl,
      watch_url: `https://www.twitch.tv/${creator.platform_username}`,
      viewer_count: typeof stream.viewer_count === "number" ? stream.viewer_count : null,
      tags_json: JSON.stringify(tags),
      is_live: 1,
      published_at: null,
      started_at: stream.started_at ? new Date(stream.started_at) : null,
      ended_at: null,
      matched_rule: matchedRule,
      is_cfc_related: isCfc ? 1 : 0,
      is_publicly_visible: isPublic ? 1 : 0,
    };

    await upsertContentItem(contentItem);

    // Send Discord live notification if not already sent.
    // Only notify for CFC-tagged streams that are publicly visible.
    // Only record the notification when the Discord send actually succeeds —
    // if messageId is null the send failed and we want the next run to retry.
    if (isPublic) {
      const alreadySent = await hasNotificationBeenSent("twitch", stream.id, "live");
      if (!alreadySent) {
        const messageId = await sendLiveNotification(
          { ...contentItem, platform_display_name: creator.platform_display_name, username: creator.username }
        );
        if (messageId) {
          await recordNotification("twitch", stream.id, "live", messageId);
        } else {
          console.warn(`[WatchTwitch] userId=${creator.user_id}: notification failed for stream "${stream.id}" — will retry on next run.`);
        }
      }

      // In-game tip announcement (deduplicated independently of Discord)
      const ingameAlreadySent = await hasNotificationBeenSent("twitch", stream.id, "ingame_live");
      if (!ingameAlreadySent) {
        const creatorName = creator.platform_display_name || creator.username;
        const announcementBody = `Creator ${creatorName} is now live — watch now at craftingforchrist.net/watch`;
        try {
          await createInGameAnnouncement(announcementBody);
          await recordNotification("twitch", stream.id, "ingame_live", null);
        } catch (err) {
          console.error(`[WatchTwitch] userId=${creator.user_id}: failed to create in-game announcement for stream "${stream.id}":`, err);
        }
      }
    }

    await updateSyncStatus(creator.user_id, "twitch", { success: true });
  } catch (err) {
    console.error(`[WatchTwitch] Sync failed for user ${creator.user_id}:`, err);
    await updateSyncStatus(creator.user_id, "twitch", { success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Cron schedule: every 5 minutes
// ---------------------------------------------------------------------------

let isTwitchSyncRunning = false;

const twitchSyncTask = cron.schedule("*/5 * * * *", async () => {
  if (!process.env.twitchClientId || !process.env.twitchClientSecret) {
    console.warn("[WatchTwitch] twitchClientId or twitchClientSecret env vars not set — skipping sync.");
    return;
  }

  if (isTwitchSyncRunning) {
    console.warn("[WatchTwitch] Previous sync is still running — skipping this tick.");
    return;
  }

  isTwitchSyncRunning = true;

  try {
    const { default: fetch } = await import("node-fetch");
    const appToken = await getTwitchAppToken(fetch);
    if (!appToken) {
      console.error("[WatchTwitch] Could not obtain app access token — aborting sync.");
      return;
    }

    const creators = await getEligibleCreators("twitch");
    if (creators.length === 0) return;

    const liveStreamIds = [];
    for (const creator of creators) {
      const broadcasterId = creator.platform_account_id;
      try {
        const streamRes = await fetch(
          `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(broadcasterId)}`,
          {
            headers: {
              Authorization: `Bearer ${appToken}`,
              "Client-Id": process.env.twitchClientId,
            },
          }
        );

        if (!streamRes.ok) {
          const body = await streamRes.text();
          console.error(`[WatchTwitch] Stream fetch failed for userId=${creator.user_id} (HTTP ${streamRes.status}):`, body);
          continue;
        }

        const streamData = await streamRes.json();
        const stream = streamData?.data?.[0] || null;

        if (stream) liveStreamIds.push(stream.id);

        await syncTwitchCreator(creator, stream);
      } catch (err) {
        console.error(`[WatchTwitch] Error during creator sync (${creator.user_id}):`, err);
      }
    }

    await markStreamsOffline("twitch", liveStreamIds);
  } catch (err) {
    console.error("[WatchTwitch] Cron error:", err);
  } finally {
    isTwitchSyncRunning = false;
  }
});

twitchSyncTask.start();
