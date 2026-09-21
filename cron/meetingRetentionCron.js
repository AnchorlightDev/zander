/**
 * Meeting Retention Cron
 *
 * Drops the hosted audio of old sessions while keeping everything that makes
 * the meeting useful — the agenda, the minutes, the discussion and the
 * transcript.  A monthly meeting is roughly 700 MB of audio a year, and the
 * default is to keep it forever, so this exists for the operator who decides
 * that is not what they want.
 *
 * Off by default, and it goes through removeSessionAudio(), which goes through
 * the archive guard: nothing is deleted unless a person has built an archive
 * and confirmed it opens.  `requireArchiveConfirmed: false` will override that,
 * and it is deliberately something an operator has to write into config and can
 * be seen to have written.
 *
 * Gated internally on config.meetings.retention.
 */

import cron from "node-cron";
import { createRequire } from "module";

import { prisma } from "../controllers/databaseController.js";
import { isPastRetention } from "../lib/meetings/archiveState.mjs";
import { removeSessionAudio } from "../services/meetingSessionService.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

const settings = config.meetings?.retention || {};
const SCHEDULE = settings.schedule || "0 5 * * *";
const AUDIO_RETENTION_DAYS = Number(settings.audioRetentionDays) || 0;
const REQUIRE_ARCHIVE_CONFIRMED = settings.requireArchiveConfirmed !== false;

export async function runMeetingRetention(now = new Date()) {
  if (!(AUDIO_RETENTION_DAYS > 0)) return;

  try {
    // Only sessions that still have audio.  Measured from when the meeting
    // happened, not from when it was archived — otherwise a late archive would
    // keep old audio alive indefinitely.
    const candidates = await prisma.meetingSessions.findMany({
      where: { audioRemovedAt: null, recordings: { some: { storagePublicId: { not: null } } } },
    });

    const due = candidates.filter((session) =>
      isPastRetention(session, { retentionDays: AUDIO_RETENTION_DAYS, now })
    );

    if (due.length === 0) return;

    for (const session of due) {
      try {
        const result = await removeSessionAudio(session.sessionId, {
          requireArchiveConfirmed: REQUIRE_ARCHIVE_CONFIRMED,
          now,
        });
        console.log(
          `[MeetingRetentionCron] session #${session.sessionId}: removed ${result.removed}/${result.total} audio asset(s)`
        );
      } catch (error) {
        // The overwhelmingly common case here is the archive guard refusing,
        // which is the system working.  Logged at info volume rather than as an
        // error so a correctly-protected session does not page anyone.
        console.log(
          `[MeetingRetentionCron] session #${session.sessionId} skipped: ${error?.message ?? error}`
        );
      }
    }
  } catch (error) {
    console.error("[MeetingRetentionCron] run failed:", error);
  }
}

if (features.meetings && settings.enabled === true) {
  cron.schedule(SCHEDULE, () => runMeetingRetention()).start();
  console.log(
    `[MeetingRetentionCron] scheduled (${SCHEDULE}), audio kept for ${AUDIO_RETENTION_DAYS} days`
  );
}
