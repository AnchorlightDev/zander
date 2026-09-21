/**
 * lib/meetings/audioTranscode.mjs
 *
 * ffmpeg wrappers for voice notes, run in child processes.
 *
 * Browser MediaRecorder output is not one format.  Chrome and Firefox produce
 * `audio/webm;codecs=opus`; iOS Safari produces `audio/mp4` with AAC in it, and
 * a large share of a volunteer roster will be commenting from a phone.  Storing
 * whatever arrived would leave the archive holding a mix of containers, the
 * transcription cron guessing, and iOS-recorded notes unplayable in browsers
 * that do not decode AAC-in-mp4 from a blob.  Both are accepted and both are
 * normalised here, once, on the way in.
 */

import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../../config.json");

function meetingsConfig() {
  return config.meetings || {};
}

function ffmpegBinary() {
  return meetingsConfig().ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
}

function ffprobeBinary() {
  return meetingsConfig().ffprobePath || process.env.FFPROBE_PATH || "ffprobe";
}

/**
 * What a browser is allowed to hand us.
 *
 * Deliberately a short list rather than "anything audio/*": this is an
 * authenticated but otherwise open upload path, and ffmpeg will happily open
 * far more formats than anyone needs to post a thirty-second comment.
 */
export const ACCEPTED_VOICE_MIME_TYPES = [
  // Chrome, Firefox, Edge, Android
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  // iOS Safari
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/x-m4a",
  "audio/aac",
  "audio/mpeg",
];

/** Content types are sent with parameters; compare on the bare type. */
export function isAcceptedVoiceMimeType(mimeType) {
  if (!mimeType) return false;
  const bare = String(mimeType).split(";")[0].trim().toLowerCase();
  return ACCEPTED_VOICE_MIME_TYPES.some((accepted) => accepted.split(";")[0] === bare);
}

function run(binary, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 65536) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });

    // A malformed upload can make ffmpeg sit on a stream indefinitely, and this
    // runs inside a request, so it gets a hard ceiling.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${binary} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${binary}: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${binary} exited ${code}: ${stderr.trim().split("\n").slice(-2).join(" | ")}`));
    });
  });
}

/**
 * Re-encode an uploaded voice note to opus-in-ogg, mono, 32 kbps.
 *
 * Mono and 32k because it is one person talking into a phone: stereo and a
 * higher bitrate would store the same speech at several times the size for no
 * audible gain, across a roster that may leave dozens of these per meeting.
 *
 * Always a re-encode, never a remux, even when the input is already opus — a
 * browser-produced webm frequently has no duration in its header, and a remux
 * carries that straight through to a player that then cannot show a scrubber.
 */
export async function normaliseVoiceNote(inputPath, outputPath) {
  await run(ffmpegBinary(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    outputPath,
  ]);

  return { outputPath, durationMs: await probeDurationMs(outputPath) };
}

/**
 * Duration in milliseconds, or null.
 *
 * Null rather than throwing: a note with an unknown duration is still a
 * perfectly good note, and the player copes with a missing length far better
 * than the upload route copes with an exception at the last step.
 */
export async function probeDurationMs(filePath) {
  try {
    const { stdout } = await run(
      ffprobeBinary(),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { timeoutMs: 15_000 }
    );

    const seconds = parseFloat(String(stdout).trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch (error) {
    console.warn("[meetings] ffprobe failed:", error.message);
    return null;
  }
}
