/**
 * Meeting Notification Cron
 *
 * Two notices, both by bot DM:
 *
 *   1. On publish — "the recording is up, you have until X".
 *   2. A nag shortly before `responseDeadlineAt`, to whoever has not responded.
 *
 * `meetingSessionAttendees`.`notifiedAt` carries both.  It is written as
 * "last notified at", which is what stops the nag repeating on every tick: once
 * it has been sent, `notifiedAt` sits inside the nag window and the query below
 * no longer selects that row.  One column, two notices, no extra state.
 *
 * Gated internally on config.meetings.notifications.
 */

import cron from "node-cron";
import { Colors, EmbedBuilder } from "discord.js";
import { createRequire } from "module";

import { prisma } from "../controllers/databaseController.js";
import { client } from "../controllers/discordController.js";
import { SESSION_STATUS } from "../services/meetingSessionService.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

const settings = config.meetings?.notifications || {};
const SCHEDULE = settings.schedule || "*/15 * * * *";
const NAG_HOURS_BEFORE = Number(settings.nagHoursBefore) || 48;

let running = false;

function meetingUrl(sessionId) {
  const base = process.env.siteAddress || "";
  return `${base.replace(/\/$/, "")}/dashboard/meetings/session?sessionId=${sessionId}`;
}

function publishEmbed(session, title) {
  const embed = new EmbedBuilder()
    .setTitle("🎧 A meeting recording is ready")
    .setDescription(
      [
        `**${title}** has been published.`,
        "",
        "The recording, the agenda and the minutes are on the meeting page. You can comment at any point on the timeline, by text or by voice note.",
      ].join("\n")
    )
    .setURL(meetingUrl(session.sessionId))
    .setColor(Colors.Blue);

  if (session.responseDeadlineAt) {
    // A Discord timestamp renders in each reader's own timezone — the same rule
    // the web side follows, and the reason this is not a formatted string.
    const unix = Math.floor(new Date(session.responseDeadlineAt).getTime() / 1000);
    embed.addFields({ name: "Comments close", value: `<t:${unix}:F> (<t:${unix}:R>)` });
  }

  return embed;
}

function nagEmbed(session, title) {
  const unix = session.responseDeadlineAt
    ? Math.floor(new Date(session.responseDeadlineAt).getTime() / 1000)
    : null;

  return new EmbedBuilder()
    .setTitle("⏰ Meeting comments close soon")
    .setDescription(
      [
        `You have not caught up on **${title}** yet.`,
        unix ? `Comments close <t:${unix}:R>.` : "Comments close soon.",
        "",
        "Marking yourself caught up on the meeting page is enough if you have nothing to add.",
      ].join("\n")
    )
    .setURL(meetingUrl(session.sessionId))
    .setColor(Colors.Orange);
}

/** DM one attendee, tolerating closed DMs the way the rest of the bot does. */
async function dm(discordId, embed) {
  if (!discordId) return false;

  try {
    const user = await client.users.fetch(discordId);
    await user.send({ embeds: [embed] });
    return true;
  } catch (error) {
    // 50007 = cannot send messages to this user (DMs closed).  Expected and
    // common; anything else is worth a line in the log.
    if (error.code !== 50007) {
      console.warn(`[MeetingNotificationCron] DM to ${discordId} failed: ${error.message}`);
    }
    return false;
  }
}

/** userId -> discordId, for the attendees about to be notified. */
async function discordIdsFor(userIds) {
  if (userIds.length === 0) return new Map();
  const users = await prisma.users.findMany({
    where: { userId: { in: userIds }, discordId: { not: null } },
    select: { userId: true, discordId: true },
  });
  return new Map(users.map((user) => [user.userId, user.discordId]));
}

export async function runMeetingNotifications(now = new Date()) {
  if (running) return;
  running = true;

  try {
    const sessions = await prisma.meetingSessions.findMany({
      where: { status: SESSION_STATUS.PUBLISHED },
      include: { event: { select: { title: true } } },
    });

    for (const session of sessions) {
      const title = session.event?.title || `Meeting session #${session.sessionId}`;

      // ── 1. First notice ────────────────────────────────────────────────
      const unnotified = await prisma.meetingSessionAttendees.findMany({
        where: { sessionId: session.sessionId, removedAt: null, canRespond: true, notifiedAt: null },
      });

      if (unnotified.length > 0) {
        const discordIds = await discordIdsFor(unnotified.map((a) => a.userId));
        const embed = publishEmbed(session, title);

        for (const attendee of unnotified) {
          await dm(discordIds.get(attendee.userId), embed);
          // Written whether or not the DM landed: a closed DM is not a reason
          // to retry every fifteen minutes forever.  The organiser sees who is
          // still outstanding on the session page and can chase them directly.
          await prisma.meetingSessionAttendees.update({
            where: { attendeeId: attendee.attendeeId },
            data: { notifiedAt: now },
          });
        }

        console.log(
          `[MeetingNotificationCron] session #${session.sessionId}: notified ${unnotified.length}`
        );
      }

      // ── 2. Nag ─────────────────────────────────────────────────────────
      if (!session.responseDeadlineAt) continue;

      const deadline = new Date(session.responseDeadlineAt);
      const windowOpensAt = new Date(deadline.getTime() - NAG_HOURS_BEFORE * 3_600_000);
      if (now < windowOpensAt || now >= deadline) continue;

      const responded = await prisma.meetingSessionProgress.findMany({
        where: { sessionId: session.sessionId, respondedAt: { not: null } },
        select: { userId: true },
      });
      const respondedIds = new Set(responded.map((row) => row.userId));

      const toNag = await prisma.meetingSessionAttendees.findMany({
        where: {
          sessionId: session.sessionId,
          removedAt: null,
          canRespond: true,
          userId: { notIn: respondedIds.size > 0 ? [...respondedIds] : [-1] },
          // Only those whose last notice predates the nag window — which is
          // exactly the once-only condition.
          notifiedAt: { lt: windowOpensAt },
        },
      });

      if (toNag.length === 0) continue;

      const discordIds = await discordIdsFor(toNag.map((a) => a.userId));
      const embed = nagEmbed(session, title);

      for (const attendee of toNag) {
        await dm(discordIds.get(attendee.userId), embed);
        await prisma.meetingSessionAttendees.update({
          where: { attendeeId: attendee.attendeeId },
          data: { notifiedAt: now },
        });
      }

      console.log(`[MeetingNotificationCron] session #${session.sessionId}: nagged ${toNag.length}`);
    }
  } catch (error) {
    console.error("[MeetingNotificationCron] run failed:", error);
  } finally {
    running = false;
  }
}

if (features.meetings && settings.enabled !== false) {
  cron.schedule(SCHEDULE, () => runMeetingNotifications()).start();
  console.log(`[MeetingNotificationCron] scheduled (${SCHEDULE})`);
}
