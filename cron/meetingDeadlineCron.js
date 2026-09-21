/**
 * Meeting Deadline Cron
 *
 * Moves a session from `published` to `closed` once its `responseDeadlineAt`
 * has passed.  Closing stops new comments; the recording, agenda, minutes and
 * existing discussion stay readable, because the point of closing is to stop
 * the conversation drifting on, not to take the record away.
 *
 * Gated internally on config.meetings.deadlineCloser.
 */

import cron from "node-cron";
import { createRequire } from "module";

import { prisma } from "../controllers/databaseController.js";
import { SESSION_STATUS, closeSession } from "../services/meetingSessionService.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

const settings = config.meetings?.deadlineCloser || {};
const SCHEDULE = settings.schedule || "10 * * * *";

export async function runMeetingDeadlineCloser(now = new Date()) {
  try {
    const due = await prisma.meetingSessions.findMany({
      where: {
        status: SESSION_STATUS.PUBLISHED,
        responseDeadlineAt: { not: null, lte: now },
      },
      select: { sessionId: true },
    });

    if (due.length === 0) return;

    for (const session of due) {
      try {
        await closeSession(session.sessionId);
        console.log(`[MeetingDeadlineCron] closed session #${session.sessionId}`);
      } catch (error) {
        console.error(
          `[MeetingDeadlineCron] could not close session #${session.sessionId}:`,
          error?.message ?? error
        );
      }
    }
  } catch (error) {
    console.error("[MeetingDeadlineCron] run failed:", error);
  }
}

if (features.meetings && settings.enabled !== false) {
  cron.schedule(SCHEDULE, () => runMeetingDeadlineCloser()).start();
  console.log(`[MeetingDeadlineCron] scheduled (${SCHEDULE})`);
}
