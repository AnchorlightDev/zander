/**
 * Event Discord Service
 * Handles creating, updating, and syncing Discord messages and Guild Scheduled Events.
 */

import { client } from "../controllers/discordController.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from "discord.js";
import { updateSyncStatus, logEventAudit } from "./eventService.js";
import { getRankMetaMap, getDonatorRankSlugs } from "./rankMetaService.js";
import {
  resolveEventAccess,
  redactLockedEvent,
  isSupporterEvent,
  buildLockCopy,
} from "../lib/eventAccess.js";

/**
 * Apply an event's rank lock before it is sent to Discord.
 *
 * The announcement channel and the guild scheduled-event list are public, so
 * posting a rank-locked event's description, server IP and host line-up there
 * would hand away exactly what the lock exists to withhold.  A locked event is
 * announced as the same teaser the website shows, with the unlock prompt and
 * the usual "View Event Online" button pointing at the page that sells it.
 *
 * Returns `null` when the event must not be announced at all -- i.e. it is
 * private, or rank-locked with the public teaser switched off.
 */
async function applyRankLock(event, siteBaseUrl = process.env.siteAddress) {
  // A channel has no single viewer to check ranks against, so the
  // least-privileged reader is the only safe assumption.
  const access = resolveEventAccess(event, []);

  if (!access.visible) return null;
  if (!access.locked) return { event, lock: null };

  const [rankMeta, donatorSlugs] = await Promise.all([
    getRankMetaMap(),
    getDonatorRankSlugs(),
  ]);

  const lock = buildLockCopy(
    access.requiredRanks,
    rankMeta,
    isSupporterEvent(access.requiredRanks, donatorSlugs),
    true // Discord readers are already "signed in" as far as the copy goes
  );

  // buildLockCopy returns a site-relative path for the website; a Discord
  // embed needs it absolute.
  if (lock.ctaUrl && siteBaseUrl) {
    const base = siteBaseUrl.endsWith("/") ? siteBaseUrl.slice(0, -1) : siteBaseUrl;
    lock.ctaUrl = `${base}${lock.ctaUrl}`;
  }

  return { event: redactLockedEvent(event), lock };
}

/** Convert HTML from Summernote to Discord-compatible markdown. */
export function htmlToMarkdown(html) {
  if (!html) return "";
  return html
    // Block-level: headings → bold line
    .replace(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi, (_, inner) => `**${inner.trim()}**\n`)
    .replace(/<h[4-6][^>]*>(.*?)<\/h[4-6]>/gi, (_, inner) => `${inner.trim()}\n`)
    // Inline formatting
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, (_, inner) => `**${inner}**`)
    .replace(/<b[^>]*>(.*?)<\/b>/gi, (_, inner) => `**${inner}**`)
    .replace(/<em[^>]*>(.*?)<\/em>/gi, (_, inner) => `*${inner}*`)
    .replace(/<i[^>]*>(.*?)<\/i>/gi, (_, inner) => `*${inner}*`)
    .replace(/<u[^>]*>(.*?)<\/u>/gi, (_, inner) => `__${inner}__`)
    .replace(/<s[^>]*>(.*?)<\/s>/gi, (_, inner) => `~~${inner}~~`)
    .replace(/<del[^>]*>(.*?)<\/del>/gi, (_, inner) => `~~${inner}~~`)
    .replace(/<code[^>]*>(.*?)<\/code>/gi, (_, inner) => `\`${inner}\``)
    // Links
    .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, text) => {
      const label = text.trim();
      return label ? `[${label}](${href})` : href;
    })
    // Lists
    .replace(/<li[^>]*>(.*?)<\/li>/gi, (_, inner) => `• ${inner.trim()}\n`)
    .replace(/<\/[uo]l>/gi, "\n")
    .replace(/<[uo]l[^>]*>/gi, "")
    // Line breaks and paragraphs
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    // Strip all remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse excess blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Prepare a banner URL for use as a Discord Guild Scheduled Event cover image.
 *
 * discord.js fetches the URL and re-encodes the bytes, but `DataResolver`
 * hard-labels every buffer as `data:image/jpg` regardless of the real format.
 * Discord sniffs PNG/JPEG fine, but silently drops WebP/GIF/AVIF covers — so an
 * event banner uploaded as `.webp` (which the uploader allows) renders in embeds
 * and the dashboard yet never appears on the Discord event itself.
 *
 * Cloudinary can bake a guaranteed-compatible asset for us: inject a
 * transformation segment after `/upload/` that forces JPEG and clamps the
 * dimensions to Discord's recommended cover size. Non-Cloudinary URLs are passed
 * through unchanged (best effort — upload your banners as PNG/JPEG).
 */
export function toDiscordCoverImage(url) {
  if (!url || typeof url !== "string") return null;

  const marker = "/image/upload/";
  const idx = url.indexOf(marker);
  if (!url.includes("res.cloudinary.com") || idx === -1) return url;

  const transform = "f_jpg,q_auto,c_limit,w_1280,h_512";
  const after = url.slice(idx + marker.length);

  // Don't double-apply if a transform is already present.
  if (after.startsWith(transform)) return url;

  return `${url.slice(0, idx + marker.length)}${transform}/${after}`;
}

/**
 * Build an embed for an event announcement/publication.
 */
function buildEventEmbed(event, lock = null) {
  const startTimestamp = Math.floor(new Date(event.startAt).getTime() / 1000);
  const endTimestamp = Math.floor(new Date(event.endAt).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(event.title)
    .setColor(0x2f508c)
    .addFields(
      { name: "Starts", value: `<t:${startTimestamp}:F> (<t:${startTimestamp}:R>)`, inline: false },
      { name: "Ends", value: `<t:${endTimestamp}:F>`, inline: false }
    );

  if (event.description) {
    embed.setDescription(htmlToMarkdown(event.description).slice(0, 2048));
  }

  if (event.locationLabel) {
    embed.addFields({ name: "Location", value: event.locationLabel, inline: true });
  }

  if (event.serverName) {
    const serverValue = event.serverIp ? `${event.serverName}\n\`${event.serverIp}\`` : event.serverName;
    embed.addFields({ name: "Server", value: serverValue, inline: true });
  }

  if (lock) {
    embed.setDescription(lock.body);
    embed.addFields({
      name: "🔒 " + lock.heading,
      value: lock.ctaUrl
        ? `[${lock.ctaLabel}](${lock.ctaUrl})`
        : `Restricted to ${lock.rankList}`,
      inline: false,
    });
  }

  embed.setImage(event.bannerUrl || null);
  embed.setThumbnail(event.logoUrl || null);

  const hosts = event.hosts || [];
  const hostNames = hosts.map(h => h.displayName || "Unknown").filter(Boolean);
  const footerParts = [];
  if (hostNames.length > 0) footerParts.push(`Hosted by ${hostNames.join(", ")}`);
  footerParts.push(`Event ID: ${event.eventId}`);
  embed.setFooter({ text: footerParts.join(" • ") });
  embed.setTimestamp();

  return embed;
}

function buildEventButton(event, siteBaseUrl) {
  const normalizedUrl = siteBaseUrl.endsWith("/") ? siteBaseUrl.slice(0, -1) : siteBaseUrl;
  const eventUrl = `${normalizedUrl}/events/${event.slug}`;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("View Event Online")
      .setURL(eventUrl)
  );
}

/**
 * Post a review-request notification embed to the configured review channel.
 * Sent when an event is submitted for review by an editor.
 */
export async function postReviewRequestDiscordMessage(event, submitterName, channelId, siteBaseUrl) {
  if (!client?.isReady?.()) throw new Error("Discord client not ready");
  if (!channelId) throw new Error("No review channel ID configured");

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased?.()) {
    throw new Error(`Channel ${channelId} is not text-based`);
  }

  const startTimestamp = Math.floor(new Date(event.startAt).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`📋 Event Pending Review: ${event.title}`)
    .setColor(0xf0a500)
    .setDescription(
      event.description
        ? htmlToMarkdown(event.description).slice(0, 512) + (event.description.length > 512 ? "…" : "")
        : null
    )
    .addFields(
      { name: "Submitted by", value: submitterName || "Unknown", inline: true },
      { name: "Starts", value: `<t:${startTimestamp}:F>`, inline: true }
    )
    .setFooter({ text: `Event ID: ${event.eventId}` })
    .setTimestamp();

  if (event.thumbnailUrl || event.logoUrl) embed.setThumbnail(event.thumbnailUrl || event.logoUrl);
  if (event.bannerUrl) embed.setImage(event.bannerUrl);

  const normalizedUrl = (siteBaseUrl || "").replace(/\/$/, "");
  const reviewUrl = `${normalizedUrl}/dashboard/events/view?eventId=${event.eventId}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Review Event")
      .setURL(reviewUrl)
  );

  await channel.send({ embeds: [embed], components: [row] });

  await logEventAudit(
    event.eventId,
    null,
    "System",
    "discord_review_notification_sent",
    `Review notification posted to channel ${channelId}`
  );
}

/**
 * Post a Discord announcement message on publish.
 * Returns the message ID.
 */
export async function postEventDiscordMessage(event, channelId, siteBaseUrl) {
  if (!client?.isReady?.()) throw new Error("Discord client not ready");
  if (!channelId) throw new Error("No channel ID provided");

  const gated = await applyRankLock(event, siteBaseUrl);
  if (!gated) {
    await logEventAudit(
      event.eventId, null, "System", "discord_message_skipped",
      "Event is not publicly visible — no Discord announcement posted"
    );
    return null;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased?.()) {
    throw new Error(`Channel ${channelId} is not text-based`);
  }

  const embed = buildEventEmbed(gated.event, gated.lock);
  const messagePayload = { embeds: [embed] };
  if (siteBaseUrl && event.slug) {
    messagePayload.components = [buildEventButton(event, siteBaseUrl)];
  }
  const msg = await channel.send(messagePayload);

  await updateSyncStatus(event.eventId, "discord", "ok", null, {
    discordMessageId: msg.id,
    discordChannelId: channelId,
  });

  await logEventAudit(
    event.eventId,
    null,
    "System",
    "discord_message_posted",
    `Discord message ${msg.id} posted to channel ${channelId}`
  );

  return msg.id;
}

/**
 * Edit an existing Discord event announcement message.
 */
export async function editEventDiscordMessage(event, channelId, messageId, siteBaseUrl) {
  if (!client?.isReady?.()) throw new Error("Discord client not ready");
  if (!channelId || !messageId) throw new Error("channelId and messageId required");

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased?.()) {
    throw new Error(`Channel ${channelId} is not text-based`);
  }

  const msg = await channel.messages.fetch(messageId);

  // An event that has since been locked down must have its already-posted
  // announcement redacted in place, not merely skipped on future posts.
  const gated = (await applyRankLock(event, siteBaseUrl)) || {
    event: redactLockedEvent(event),
    lock: null,
  };

  const embed = buildEventEmbed(gated.event, gated.lock);
  const editPayload = { embeds: [embed] };
  if (siteBaseUrl && event.slug) {
    editPayload.components = [buildEventButton(event, siteBaseUrl)];
  }
  await msg.edit(editPayload);

  await logEventAudit(
    event.eventId,
    null,
    "System",
    "discord_message_updated",
    `Discord message ${messageId} updated in channel ${channelId}`
  );

  return messageId;
}

/**
 * Create a Discord Guild Scheduled Event.
 * Returns the guild event ID.
 */
export async function createGuildScheduledEvent(event, guildId) {
  if (!client?.isReady?.()) throw new Error("Discord client not ready");
  if (!guildId) throw new Error("No guild ID provided");

  const gated = await applyRankLock(event);
  if (!gated) {
    await logEventAudit(
      event.eventId, null, "System", "discord_guild_event_skipped",
      "Event is not publicly visible — no Discord scheduled event created"
    );
    return null;
  }

  const guild = await client.guilds.fetch(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found`);

  // The voice channel itself is role-gated on Discord's side, so it stays on a
  // locked event; only the written detail is withheld.
  const isVoiceChannel = event.locationType === "discord" && event.locationDiscordChannelId;

  const eventData = {
    name: event.title,
    scheduledStartTime: new Date(event.startAt),
    scheduledEndTime: new Date(event.endAt),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    description: gated.lock
      ? gated.lock.body.slice(0, 1000)
      : event.description
        ? htmlToMarkdown(event.description).slice(0, 1000)
        : undefined,
    ...(isVoiceChannel
      ? {
          entityType: GuildScheduledEventEntityType.Voice,
          channel: event.locationDiscordChannelId,
        }
      : {
          entityType: GuildScheduledEventEntityType.External,
          entityMetadata: {
            location: gated.lock
              ? "Members only"
              : event.locationLabel || event.serverIp || "Online",
          },
        }),
  };

  if (event.bannerUrl) {
    eventData.image = toDiscordCoverImage(event.bannerUrl);
  }

  let guildEvent;
  try {
    guildEvent = await guild.scheduledEvents.create(eventData);
  } catch (err) {
    // A bad/unreachable cover image must not stop the event being created.
    if (eventData.image) {
      console.error(
        `[EventDiscord] Guild event create failed with cover image, retrying without it:`,
        err.message
      );
      delete eventData.image;
      guildEvent = await guild.scheduledEvents.create(eventData);
    } else {
      throw err;
    }
  }

  await updateSyncStatus(event.eventId, "discord", "ok", null, {
    discordGuildEventId: guildEvent.id,
  });

  await logEventAudit(
    event.eventId,
    null,
    "System",
    "discord_guild_event_created",
    `Discord guild event ${guildEvent.id} created in guild ${guildId}`
  );

  return guildEvent.id;
}

/**
 * Edit an existing Discord Guild Scheduled Event.
 */
export async function editGuildScheduledEvent(event, guildId, guildEventId) {
  if (!client?.isReady?.()) throw new Error("Discord client not ready");
  if (!guildId || !guildEventId) throw new Error("guildId and guildEventId required");

  const guild = await client.guilds.fetch(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found`);

  const guildEvent = await guild.scheduledEvents.fetch(guildEventId);
  if (!guildEvent) throw new Error(`Guild event ${guildEventId} not found`);

  // A newly locked event must lose its description here too, so `null` (not
  // publicly visible at all) still redacts rather than leaving the old text.
  const gated = (await applyRankLock(event)) || { event, lock: null, hidden: true };

  const isVoiceChannel = event.locationType === "discord" && event.locationDiscordChannelId;

  const editData = {
    name: event.title,
    scheduledStartTime: new Date(event.startAt),
    scheduledEndTime: new Date(event.endAt),
    description: gated.lock
      ? gated.lock.body.slice(0, 1000)
      : gated.hidden
        ? undefined
        : event.description
          ? htmlToMarkdown(event.description).slice(0, 1000)
          : undefined,
    ...(isVoiceChannel
      ? {
          entityType: GuildScheduledEventEntityType.Voice,
          channel: event.locationDiscordChannelId,
        }
      : {
          entityType: GuildScheduledEventEntityType.External,
          entityMetadata: {
            location: gated.lock
              ? "Members only"
              : event.locationLabel || event.serverIp || "Online",
          },
        }),
  };

  if (event.bannerUrl) {
    editData.image = toDiscordCoverImage(event.bannerUrl);
  } else {
    // Explicitly clear the image if bannerUrl was removed
    editData.image = null;
  }

  try {
    await guildEvent.edit(editData);
  } catch (err) {
    if (editData.image) {
      console.error(
        `[EventDiscord] Guild event edit failed with cover image, retrying without it:`,
        err.message
      );
      delete editData.image;
      await guildEvent.edit(editData);
    } else {
      throw err;
    }
  }

  await logEventAudit(
    event.eventId,
    null,
    "System",
    "discord_guild_event_updated",
    `Discord guild event ${guildEventId} updated`
  );

  return guildEventId;
}

/**
 * Post a cancellation notice to the event's Discord channel.
 */
export async function postCancellationDiscordMessage(event, channelId) {
  if (!client?.isReady?.()) throw new Error("Discord client not ready");
  if (!channelId) throw new Error("No channel ID provided");

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased?.()) throw new Error(`Channel ${channelId} is not text-based`);

  const startTimestamp = Math.floor(new Date(event.startAt).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`❌ Event Cancelled: ${event.title}`)
    .setDescription(
      `This event has been cancelled and will no longer take place.\n\n` +
      `Originally scheduled for <t:${startTimestamp}:F>.`
    )
    .setColor(0xe74c3c)
    .setFooter({ text: `Event ID: ${event.eventId}` })
    .setTimestamp();

  if (event.bannerUrl) embed.setImage(event.bannerUrl);

  await channel.send({ embeds: [embed] });

  await logEventAudit(
    event.eventId,
    null,
    "System",
    "discord_cancellation_posted",
    `Cancellation notice posted to channel ${channelId}`
  );
}

/**
 * Cancel a Discord Guild Scheduled Event.
 */
export async function cancelGuildScheduledEvent(event, guildId, guildEventId) {
  if (!client?.isReady?.()) return;
  if (!guildId || !guildEventId) return;

  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) return;

    const guildEvent = await guild.scheduledEvents.fetch(guildEventId).catch(() => null);
    if (!guildEvent) return;

    await guildEvent.delete();

    await logEventAudit(
      event.eventId,
      null,
      "System",
      "discord_guild_event_cancelled",
      `Discord guild event ${guildEventId} cancelled`
    );
  } catch (error) {
    console.error("[EventDiscord] Failed to cancel guild event:", error.message);
  }
}

/**
 * Run all enabled Discord actions for an event on a given trigger.
 * config should include: { channelId, guildId, createGuildEvent }
 */
export async function runDiscordActionsForEvent(event, trigger, discordConfig = {}) {
  const actions = (event.actions || []).filter((a) => a.enabled && a.trigger === trigger);

  for (const action of actions) {
    const cfg = action.config || {};
    const channelId = cfg.channelId || discordConfig.channelId;
    const guildId = cfg.guildId || discordConfig.guildId;

    const siteBaseUrl = discordConfig.siteBaseUrl || "";

    try {
      if (action.actionType === "discord_message") {
        if (trigger === "on_publish") {
          await postEventDiscordMessage(event, channelId, siteBaseUrl);
        } else if (trigger === "on_update" && event.discordMessageId && event.discordChannelId) {
          await editEventDiscordMessage(event, event.discordChannelId, event.discordMessageId, siteBaseUrl);
        } else if (trigger === "on_cancel") {
          const targetChannel = event.discordChannelId || channelId;
          if (targetChannel) await postCancellationDiscordMessage(event, targetChannel);
        }
      }

      if (action.actionType === "discord_guild_event") {
        if (trigger === "on_publish") {
          await createGuildScheduledEvent(event, guildId);
        } else if (trigger === "on_update") {
          if (event.discordGuildEventId) {
            await editGuildScheduledEvent(event, guildId, event.discordGuildEventId);
          } else {
            await createGuildScheduledEvent(event, guildId);
          }
        } else if (trigger === "on_cancel" && event.discordGuildEventId) {
          await cancelGuildScheduledEvent(event, guildId, event.discordGuildEventId);
        }
      }

      if (action.actionType === "website_page") {
        if (trigger === "on_publish") {
          await updateSyncStatus(event.eventId, "website", "ok", null);
          await logEventAudit(
            event.eventId,
            null,
            "System",
            "website_published",
            `Event listed on /events`
          );
        }
      }

      // Mark action as run
      await updateActionRunStatus(action.id, "ok", null);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[EventDiscord] Action ${action.id} (${action.actionType}) failed:`, errMsg);
      await updateActionRunStatus(action.id, "failed", errMsg);

      await updateSyncStatus(event.eventId, "discord", "failed", errMsg);
    }
  }
}

async function updateActionRunStatus(actionId, status, error) {
  const { prisma } = await import("../controllers/databaseController.js");
  await prisma.event_actions.update({
    where: { id: actionId },
    data: { lastRunAt: new Date(), lastRunStatus: status, lastRunError: error || null },
  });
}
