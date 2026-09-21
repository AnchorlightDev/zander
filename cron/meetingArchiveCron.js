/**
 * Meeting Archive Cron
 *
 * Builds export bundles for sessions whose `archiveStatus` is 'requested'.
 *
 * Here rather than in the request that asked for it: a bundle is the audio plus
 * the transcript plus every voice note, zipped — minutes of work and hundreds
 * of megabytes streaming through.  Doing that inside an HTTP handler would hold
 * a connection open past every sensible timeout and compete with every other
 * request on the same process.
 *
 * Note what this job does NOT do: it never sets `archiveConfirmedAt`, and so it
 * never unlocks deleting the audio.  A person has to open the bundle and say it
 * is intact first.
 *
 * Gated internally on config.meetings.archive.
 */

import cron from "node-cron";
import { createRequire } from "module";

import { buildArchive, pendingArchiveRequests } from "../services/meetingArchiveService.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

const settings = config.meetings?.archive || {};
const SCHEDULE = settings.schedule || "*/20 * * * *";
const BATCH_SIZE = Number(settings.batchSize) || 2;

let running = false;

export async function runMeetingArchiveBuilder() {
  if (running) return;
  running = true;

  try {
    const sessions = await pendingArchiveRequests(BATCH_SIZE);
    if (sessions.length === 0) return;

    console.log(`[MeetingArchiveCron] building ${sessions.length} archive(s)`);

    // One at a time: each build is streaming a whole meeting's audio through
    // the zip, and two at once doubles both the disk churn and the egress.
    for (const session of sessions) {
      try {
        const result = await buildArchive(session.sessionId);
        console.log(
          `[MeetingArchiveCron] session #${session.sessionId}: ${(result.bytes / 1048576).toFixed(1)} MB ready — awaiting confirmation`
        );
      } catch (error) {
        // buildArchive has already moved the session to 'failed', so the
        // organiser can see it and retry rather than watching it sit queued.
        console.error(
          `[MeetingArchiveCron] session #${session.sessionId} failed:`,
          error?.message ?? error
        );
      }
    }
  } catch (error) {
    console.error("[MeetingArchiveCron] run failed:", error);
  } finally {
    running = false;
  }
}

if (features.meetings && settings.enabled !== false) {
  cron.schedule(SCHEDULE, runMeetingArchiveBuilder).start();
  console.log(`[MeetingArchiveCron] scheduled (${SCHEDULE})`);
}
