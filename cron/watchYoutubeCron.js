/**
 * YouTube content sync cron.
 *
 * Runs every 15 minutes. For each eligible creator with an active YouTube connection:
 *   - Fetches recent videos and live streams from the YouTube Data API v3
 *   - Applies CFC content filters (tags and description markers)
 *   - Upserts eligible items into creator_content_items
 *   - Marks live streams that have ended
 *   - Sends one-time Discord notifications for new eligible uploads and live streams
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
// Discord notification helpers
// ---------------------------------------------------------------------------

async function sendDiscordNotification(notifType, item) {
  const channelId = config?.watch?.contentChannelId;
  if (!channelId) {
    console.warn("[WatchYouTube] contentChannelId is not set in config.json — skipping Discord notification.");
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.warn(`[WatchYouTube] Discord channel "${channelId}" not found — skipping notification.`);
      return null;
    }

    const isLive = notifType === "live";
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle(
        isLive
          ? `${item.creatorDisplayName} is live on YouTube!`
          : `New video by ${item.creatorDisplayName}`
      )
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
    console.error("[WatchYouTube] Discord notification failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// YouTube API helpers
// ---------------------------------------------------------------------------

const YT_BASE = "https://www.googleapis.com/youtube/v3";

async function fetchYoutubeVideoDetails(videoIds, apiKey, fetchFn) {
  if (!videoIds || videoIds.length === 0) return [];

  const ids = videoIds.slice(0, 50).join(",");
  const url = `${YT_BASE}/videos?part=snippet,liveStreamingDetails,statistics&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(apiKey)}`;

  const res = await fetchFn(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[WatchYouTube] videos.list API error (${res.status}):`, body);
    return [];
  }

  const data = await res.json();
  return data?.items || [];
}

async function resolveChannelId(rawId, apiKey, fetchFn) {
  // Already a proper channel ID
  if (rawId && rawId.startsWith("UC")) return rawId;

  // Try resolving via handle (@username) or legacy username
  const isHandle = rawId && rawId.startsWith("@");
  const param = isHandle
    ? `forHandle=${encodeURIComponent(rawId)}`
    : `forUsername=${encodeURIComponent(rawId)}`;

  const url = `${YT_BASE}/channels?part=id&${param}&key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) {
      const body = await res.text();
      console.error(`[WatchYouTube] channels.list resolve error (${res.status}):`, body);
      return rawId;
    }
    const data = await res.json();
    const resolved = data?.items?.[0]?.id;
    if (resolved) return resolved;
    console.warn(`[WatchYouTube] Could not resolve channel "${rawId}" — no items returned. Using raw value.`);
  } catch (err) {
    console.error("[WatchYouTube] Channel ID resolution failed:", err);
  }
  return rawId;
}

// Cache uploads playlist IDs — these never change for a channel so we only
// need to fetch them once per process lifetime (or per cold start).
const uploadsPlaylistCache = new Map();

/**
 * Returns the uploads playlist ID for a channel.
 * Costs 1 quota unit on first call; free thereafter (in-memory cache).
 */
async function getUploadsPlaylistId(channelId, apiKey, fetchFn) {
  if (uploadsPlaylistCache.has(channelId)) {
    return uploadsPlaylistCache.get(channelId);
  }

  const url = `${YT_BASE}/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[WatchYouTube] channels.list (contentDetails) error (${res.status}):`, body);
    return null;
  }

  const data = await res.json();
  const playlistId = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (playlistId) {
    uploadsPlaylistCache.set(channelId, playlistId);
  } else {
    console.warn(`[WatchYouTube] No uploads playlist found for channel "${channelId}" — channel may be private or API response was empty.`);
  }
  return playlistId || null;
}

/**
 * Fetches recent video IDs from the channel's uploads playlist.
 * Costs 1 quota unit (playlistItems.list) — replaces search.list (100 units).
 */
async function fetchRecentChannelItems(channelId, apiKey, fetchFn) {
  const playlistId = await getUploadsPlaylistId(channelId, apiKey, fetchFn);
  if (!playlistId) {
    console.warn(`[WatchYouTube] Skipping uploads fetch for channel "${channelId}" — no playlist ID available.`);
    return [];
  }

  const url = `${YT_BASE}/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(playlistId)}&maxResults=15&key=${encodeURIComponent(apiKey)}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[WatchYouTube] playlistItems.list error (${res.status}):`, body);
    return [];
  }

  const data = await res.json();
  // Return in the same shape the rest of the code expects: [{id:{videoId}}]
  return (data?.items || []).map((i) => ({ id: { videoId: i.contentDetails?.videoId } }));
}

// ---------------------------------------------------------------------------
// Sync logic for a single creator
// ---------------------------------------------------------------------------

async function syncYoutubeCreator(creator, apiKey, fetchFn) {
  const rawChannelId = creator.platform_channel_id || creator.platform_account_id;
  if (!rawChannelId) {
    console.warn(`[WatchYouTube] userId=${creator.user_id} (${creator.username}): no platform_channel_id or platform_account_id — skipping.`);
    return [];
  }

  const channelId = await resolveChannelId(rawChannelId, apiKey, fetchFn);
  const liveIds = [];

  try {
    const searchItems = await fetchRecentChannelItems(channelId, apiKey, fetchFn);
    if (searchItems.length === 0) {
      await updateSyncStatus(creator.user_id, "youtube", { success: true });
      return liveIds;
    }

    const videoIds = searchItems.map((i) => i.id?.videoId).filter(Boolean);
    const videoDetails = await fetchYoutubeVideoDetails(videoIds, apiKey, fetchFn);

    for (const video of videoDetails) {
      const snippet = video.snippet || {};
      const liveDetails = video.liveStreamingDetails || null;
      const statistics = video.statistics || null;

      const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
      const description = snippet.description || "";
      const title = snippet.title || "";
      const liveBroadcastContent = snippet.liveBroadcastContent; // "live", "upcoming", "none"

      // Skip if it's still upcoming
      if (liveBroadcastContent === "upcoming") continue;

      const matchedRule = matchesCfcFilter(
        "youtube",
        { title, description, tags },
        config
      );

      const isCfc = Boolean(matchedRule);

      // Determine content type and live status
      const isCurrentlyLive = liveBroadcastContent === "live";
      const contentType = isCurrentlyLive || liveBroadcastContent === "upcoming" ? "live_stream" : "video";

      // Only CFC-tagged content is publicly visible
      const isPublic = isCfc;

      const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
      const startedAt = liveDetails?.actualStartTime ? new Date(liveDetails.actualStartTime) : null;
      const endedAt = liveDetails?.actualEndTime ? new Date(liveDetails.actualEndTime) : null;

      const watchUrl = `https://www.youtube.com/watch?v=${video.id}`;

      // Best thumbnail
      const thumbs = snippet.thumbnails || {};
      const thumbnailUrl =
        thumbs.maxres?.url ||
        thumbs.high?.url ||
        thumbs.medium?.url ||
        thumbs.default?.url ||
        null;

      const contentItem = {
        user_id: creator.user_id,
        platform: "youtube",
        external_content_id: video.id,
        external_channel_id: channelId,
        content_type: contentType,
        title,
        description: description.substring(0, 500),
        thumbnail_url: thumbnailUrl,
        watch_url: watchUrl,
        viewer_count: isCurrentlyLive
          ? (liveDetails?.concurrentViewers != null ? parseInt(liveDetails.concurrentViewers, 10) : null)
          : (statistics?.viewCount != null ? parseInt(statistics.viewCount, 10) : null),
        tags_json: JSON.stringify(tags),
        is_live: isCurrentlyLive ? 1 : 0,
        published_at: publishedAt,
        started_at: startedAt,
        ended_at: endedAt,
        matched_rule: matchedRule,
        is_cfc_related: isCfc ? 1 : 0,
        is_publicly_visible: isPublic ? 1 : 0,
      };

      await upsertContentItem(contentItem);

      if (isCurrentlyLive) liveIds.push(video.id);

      if (!isPublic) continue;

      // Skip notifications for content that was already published before the
      // creator linked their account — prevents a flood of announcements on
      // first connection.  Currently-live streams are always announced since
      // they are actively happening right now.
      if (!isCurrentlyLive && publishedAt && creator.created_at && publishedAt < new Date(creator.created_at)) {
        continue;
      }

      // Discord notifications
      const notifType = isCurrentlyLive ? "live" : "upload";
      const alreadySent = await hasNotificationBeenSent("youtube", video.id, notifType);
      if (!alreadySent) {
        const messageId = await sendDiscordNotification(
          notifType,
          {
            ...contentItem,
            creatorDisplayName: creator.platform_display_name || creator.username,
          }
        );
        // Only record as sent if the Discord message actually went through.
        // If messageId is null the send failed; leave the record absent so
        // the next cron run can retry.
        if (messageId) {
          await recordNotification("youtube", video.id, notifType, messageId);
        } else {
          console.warn(`[WatchYouTube] userId=${creator.user_id}: notification failed for "${video.id}" — will retry on next run.`);
        }
      }

      // In-game tip announcement (deduplicated independently of Discord)
      const ingameNotifType = `ingame_${notifType}`;
      const ingameAlreadySent = await hasNotificationBeenSent("youtube", video.id, ingameNotifType);
      if (!ingameAlreadySent) {
        const creatorName = creator.platform_display_name || creator.username;
        const announcementBody = isCurrentlyLive
          ? `Creator ${creatorName} is now live — watch now at craftingforchrist.net/watch`
          : `Creator ${creatorName} has released a new video — watch now at craftingforchrist.net/watch`;
        try {
          await createInGameAnnouncement(announcementBody);
          await recordNotification("youtube", video.id, ingameNotifType, null);
        } catch (err) {
          console.error(`[WatchYouTube] userId=${creator.user_id}: failed to create in-game announcement for "${video.id}":`, err);
        }
      }
    }

    await updateSyncStatus(creator.user_id, "youtube", { success: true });
  } catch (err) {
    console.error(`[WatchYouTube] Sync failed for user ${creator.user_id}:`, err);
    await updateSyncStatus(creator.user_id, "youtube", { success: false, error: err.message });
  }

  return liveIds;
}

// ---------------------------------------------------------------------------
// Cron schedule: every 15 minutes
// ---------------------------------------------------------------------------

let isYoutubeSyncRunning = false;

const youtubeSyncTask = cron.schedule("*/15 * * * *", async () => {
  const apiKey = process.env.youtubeApiKey;
  if (!apiKey) {
    console.warn("[WatchYouTube] youtubeApiKey env var is not set — skipping sync.");
    return;
  }

  if (isYoutubeSyncRunning) {
    console.warn("[WatchYouTube] Previous sync is still running — skipping this tick.");
    return;
  }

  isYoutubeSyncRunning = true;

  try {
    const { default: fetch } = await import("node-fetch");
    const creators = await getEligibleCreators("youtube");
    if (creators.length === 0) return;

    const allLiveIds = [];
    for (const creator of creators) {
      const liveIds = await syncYoutubeCreator(creator, apiKey, fetch);
      allLiveIds.push(...liveIds);
    }

    await markStreamsOffline("youtube", allLiveIds);
  } catch (err) {
    console.error("[WatchYouTube] Cron error:", err);
  } finally {
    isYoutubeSyncRunning = false;
  }
});

youtubeSyncTask.start();
