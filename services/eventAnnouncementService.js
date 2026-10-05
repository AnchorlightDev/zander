/**
 * Event Announcement Service
 * Handles scheduled Discord (and future platform) announcements for events.
 */

import { prisma } from "../controllers/databaseController.js";
import { client } from "../controllers/discordController.js";
import { EmbedBuilder } from "discord.js";
import { logEventAudit } from "./eventService.js";

/**
 * Wording used when an announcement has no content template, chosen by when
 * it fires (announcementType is a free label and was never reliable for this).
 * Relative timestamps keep it right even if it goes out late.
 */
function defaultAnnouncementText(announcement) {
  switch (announcement.triggerType) {
    case "on_publish":
      return "A new event has been announced: **{title}**\n\n{startAt} ({startRelative})";
    case "before_event":
      return "**{title}** starts {startRelative}!";
    case "event_start":
      return "**{title}** is starting now!";
    case "after_event":
      return "**{title}** has ended. Thanks for participating!";
    default:
      return "Reminder: **{title}** — {startAt}";
  }
}

/**
 * Build a Discord embed for an event announcement.
 */
function buildAnnouncementEmbed(event, announcement) {
  let description = announcement.contentTemplate || defaultAnnouncementText(announcement);

  // Replace template variables
  const startTs = Math.floor(new Date(event.startAt).getTime() / 1000);
  const endTs = event.endAt ? Math.floor(new Date(event.endAt).getTime() / 1000) : null;

  description = description
    .replace(/\{title\}/g, event.title)
    .replace(/\{description\}/g, event.description || "")
    .replace(/\{location\}/g, event.locationLabel || "TBA")
    .replace(/\{server\}/g, event.serverName || "")
    .replace(/\{serverIp\}/g, event.serverIp || "")
    // Start time — Discord timestamp formats
    .replace(/\{startAt\}/g, `<t:${startTs}:F>`)
    .replace(/\{startRelative\}/g, `<t:${startTs}:R>`)
    .replace(/\{discord_t\}/g, `<t:${startTs}:t>`)   // short time: 9:01 AM
    .replace(/\{discord_T\}/g, `<t:${startTs}:T>`)   // long time: 9:01:00 AM
    .replace(/\{discord_d\}/g, `<t:${startTs}:d>`)   // short date: 20/04/2021
    .replace(/\{discord_D\}/g, `<t:${startTs}:D>`)   // long date: 20 April 2021
    .replace(/\{discord_f\}/g, `<t:${startTs}:f>`)   // short date/time: 20 April 2021 09:01
    .replace(/\{discord_F\}/g, `<t:${startTs}:F>`)   // full date/time: Tuesday, 20 April 2021 09:01
    .replace(/\{discord_R\}/g, `<t:${startTs}:R>`)   // relative: 2 months ago
    // End time
    .replace(/\{endAt\}/g, endTs ? `<t:${endTs}:F>` : "")
    .replace(/\{endRelative\}/g, endTs ? `<t:${endTs}:R>` : "");

  const embed = new EmbedBuilder()
    .setTitle(event.title)
    .setDescription(description)
    .setColor(0x2f508c)
    .addFields(
      { name: "Starts", value: `<t:${Math.floor(new Date(event.startAt).getTime() / 1000)}:F>`, inline: true },
      { name: "Ends", value: `<t:${Math.floor(new Date(event.endAt).getTime() / 1000)}:F>`, inline: true }
    );

  if (event.locationLabel) {
    embed.addFields({ name: "Location", value: event.locationLabel, inline: true });
  }

  if (event.serverIp) {
    embed.addFields({ name: "Server IP", value: `\`${event.serverIp}\``, inline: true });
  }

  if (event.bannerUrl) {
    embed.setImage(event.bannerUrl);
  }

  if (event.logoUrl) {
    embed.setThumbnail(event.logoUrl);
  }

  return embed;
}

/**
 * Send a single announcement for an event.
 */
export async function sendAnnouncement(announcementId) {
  const announcement = await prisma.event_announcements.findUnique({
    where: { id: announcementId },
    include: { event: true },
  });

  if (!announcement) throw new Error(`Announcement #${announcementId} not found`);
  if (announcement.status !== "pending") {
    throw new Error(`Announcement #${announcementId} is not pending (status: ${announcement.status})`);
  }

  const { event } = announcement;

  if (announcement.platform === "discord") {
    await sendDiscordAnnouncement(announcement, event);
  }
  // Future: email, push notification, etc.
}

/**
 * Send a Discord announcement message.
 */
async function sendDiscordAnnouncement(announcement, event) {
  if (!client?.isReady?.()) {
    await prisma.event_announcements.update({
      where: { id: announcement.id },
      data: { status: "failed", lastError: "Discord client not ready" },
    });
    throw new Error("Discord client not ready");
  }

  const channelId = announcement.channelId;
  if (!channelId) {
    await prisma.event_announcements.update({
      where: { id: announcement.id },
      data: { status: "failed", lastError: "No channel ID configured" },
    });
    throw new Error("No channel ID configured for announcement");
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      throw new Error(`Channel ${channelId} is not text-based`);
    }

    const embed = buildAnnouncementEmbed(event, announcement);
    const msg = await channel.send({ embeds: [embed] });

    await prisma.event_announcements.update({
      where: { id: announcement.id },
      data: {
        status: "sent",
        sentAt: new Date(),
        discordMessageId: msg.id,
        lastError: null,
      },
    });

    await logEventAudit(
      event.eventId,
      null,
      "System",
      "announcement_sent",
      `Announcement #${announcement.id} (${announcement.announcementType}) sent to channel ${channelId}`
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    await prisma.event_announcements.update({
      where: { id: announcement.id },
      data: { status: "failed", lastError: errMsg },
    });

    await logEventAudit(
      event.eventId,
      null,
      "System",
      "announcement_failed",
      `Announcement #${announcement.id} failed: ${errMsg}`
    );

    throw error;
  }
}

/**
 * Discord announcements that are due. Only for published events: a draft's
 * announcements must never post, and cancelled, archived and deleted events
 * are over.
 */
export async function getDueAnnouncements() {
  const now = new Date();
  return prisma.event_announcements.findMany({
    where: {
      status: "pending",
      enabled: true,
      platform: "discord",
      scheduledFor: { lte: now },
      event: { status: "published", deletedAt: null },
    },
    include: { event: true },
    orderBy: { scheduledFor: "asc" },
    take: 50,
  });
}

/**
 * Process all due announcements. Called by cron.
 */
export async function processDueAnnouncements() {
  const results = { sent: 0, failed: 0 };
  // Wait for the bot rather than failing everything due while it reconnects:
  // a failed announcement is never retried.
  if (!client?.isReady?.()) return results;

  const due = await getDueAnnouncements();

  for (const announcement of due) {
    try {
      await sendAnnouncement(announcement.id);
      results.sent++;
    } catch (error) {
      console.error(`[EventAnnouncements] Failed to send #${announcement.id}:`, error.message);
      results.failed++;
    }
  }

  return results;
}
