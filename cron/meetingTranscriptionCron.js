/**
 * Meeting Transcription Cron
 *
 * Drains `transcriptStatus = 'pending'` on meeting recordings and voice-note
 * comments through Whisper, with word-level timestamps.
 *
 * Gated internally on config.meetings.transcription, per the project convention
 * that app.js imports every cron unconditionally and each file decides for
 * itself whether it should run.
 *
 * Batched small and run often rather than in one sweep: a transcription is
 * minutes of CPU (or an API call per file), and this process is also serving
 * every HTTP request and running the Discord bot.
 */

import cron from "node-cron";
import { createRequire } from "module";
import {
  isTranscriptionEnabled,
  pendingTranscriptionWork,
  transcribeRecording,
  transcribeVoiceComment,
} from "../services/meetingTranscriptionService.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

const settings = config.meetings?.transcription || {};
const SCHEDULE = settings.schedule || "*/10 * * * *";
const BATCH_SIZE = Number(settings.batchSize) || 3;

/** Stops a long run overlapping the next tick and doubling the CPU load. */
let running = false;

export async function runMeetingTranscription() {
  if (running) return;
  running = true;

  try {
    const { recordings, comments } = await pendingTranscriptionWork(BATCH_SIZE);
    if (recordings.length === 0 && comments.length === 0) return;

    console.log(
      `[MeetingTranscriptionCron] ${recordings.length} recording(s), ${comments.length} voice note(s) pending`
    );

    // Sequentially, not in parallel: whichever provider is configured, running
    // several at once either saturates the host or hits an API rate limit, and
    // the work is not urgent enough to be worth either.
    for (const recording of recordings) {
      try {
        await transcribeRecording(recording.recordingId);
        console.log(`[MeetingTranscriptionCron] transcribed recording #${recording.recordingId}`);
      } catch (error) {
        // The failure is already recorded on the row by the service, so the
        // organiser can see it and retry rather than watching it sit pending.
        console.error(
          `[MeetingTranscriptionCron] recording #${recording.recordingId} failed:`,
          error?.message ?? error
        );
      }
    }

    for (const comment of comments) {
      try {
        await transcribeVoiceComment(comment.commentId);
      } catch (error) {
        console.error(
          `[MeetingTranscriptionCron] voice note #${comment.commentId} failed:`,
          error?.message ?? error
        );
      }
    }
  } catch (error) {
    console.error("[MeetingTranscriptionCron] run failed:", error);
  } finally {
    running = false;
  }
}

if (features.meetings && settings.enabled !== false && isTranscriptionEnabled()) {
  cron.schedule(SCHEDULE, runMeetingTranscription).start();
  console.log(`[MeetingTranscriptionCron] scheduled (${SCHEDULE})`);
}
