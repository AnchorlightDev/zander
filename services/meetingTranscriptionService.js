/**
 * Meeting Transcription Service
 *
 * Whisper transcription for meeting recordings and voice notes, with
 * word-level timestamps.
 *
 * This is the highest-value part of the recording feature and it is worth being
 * explicit about why: almost nobody listens to ninety minutes of audio to find
 * out what was decided.  They skim.  A transcript makes the recording skimmable,
 * makes a line clickable so it seeks the audio, and — because it is text in the
 * database — makes every meeting ever held searchable.  The audio is the
 * evidence; the transcript is the thing people actually use.
 *
 * ANCHOR RULE: Whisper timestamps are relative to the file it was given.  They
 * are converted to session offsets — by adding the recording's `startOffsetMs`
 * — in exactly one place, transcribeRecording() below, before anything is
 * stored or rendered.
 */

import { createReadStream } from "fs";
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import fetch from "node-fetch";

import { prisma } from "../controllers/databaseController.js";
import { TRANSCRIPT_STATUS } from "./meetingSessionService.js";
import { isCloudinaryConfigured, signedAssetUrl } from "./cloudinaryService.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");

function transcriptionConfig() {
  return config.meetings?.transcription || {};
}

/**
 * Which Whisper to use.
 *
 *   openai      — the hosted API.  Nothing to install; audio leaves the host.
 *   whisper-cli — a local whisper.cpp / openai-whisper binary.  Nothing leaves
 *                 the host, which is the right answer for internal staff
 *                 meetings on a box that can afford the CPU.
 *   disabled    — the default.  Transcription is opt-in because both options
 *                 have a cost the operator has to choose to pay.
 */
export function transcriptionProvider() {
  return transcriptionConfig().provider || "disabled";
}

export function isTranscriptionEnabled() {
  return transcriptionProvider() !== "disabled";
}

// ============================================================================
// Formatting
// ============================================================================

function vttTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/**
 * WebVTT, which is what a <track> element takes — so the transcript renders as
 * captions against the audio with no client-side parsing at all.
 *
 * Cues are written at session offsets, so a VTT from the second recording of a
 * reconnected meeting still lines up with the agenda.
 */
export function toVtt(segments, { speakerNames = new Map() } = {}) {
  const lines = ["WEBVTT", ""];

  segments.forEach((segment, index) => {
    const speaker = segment.speakerUserId != null ? speakerNames.get(segment.speakerUserId) : null;
    lines.push(String(index + 1));
    lines.push(`${vttTimestamp(segment.startMs)} --> ${vttTimestamp(segment.endMs)}`);
    lines.push(speaker ? `<v ${speaker}>${segment.text.trim()}` : segment.text.trim());
    lines.push("");
  });

  return lines.join("\n");
}

/** Plain text, for the archive and for anyone who just wants to read it. */
export function toPlainText(segments, { speakerNames = new Map() } = {}) {
  return segments
    .map((segment) => {
      const stamp = vttTimestamp(segment.startMs).slice(0, 8);
      const speaker = segment.speakerUserId != null ? speakerNames.get(segment.speakerUserId) : null;
      return `[${stamp}] ${speaker ? `${speaker}: ` : ""}${segment.text.trim()}`;
    })
    .join("\n");
}

// ============================================================================
// Diarisation
// ============================================================================

/**
 * Attach a speaker to each segment using the intervals the recorder logged
 * live.
 *
 * Pure, so the overlap rules are testable without audio.  This is what gets
 * "who said what" out of a single mixed-down file: the recorder already knew
 * who was talking when, so there is no need for acoustic speaker separation and
 * no need to keep a separate audio track per person.
 *
 * A segment is attributed to whoever was speaking for the most of it.  Ties and
 * crosstalk leave it unattributed rather than guessing — an unattributed line
 * is honest, a wrongly attributed one puts words in someone's mouth.
 */
export function attributeSegments(segments, intervals) {
  const rows = (intervals || []).map((interval) => ({
    userId: interval.userId ?? null,
    discordUserId: interval.discordUserId ?? null,
    startMs: Number(interval.startOffsetMs),
    endMs: interval.endOffsetMs == null ? Number.MAX_SAFE_INTEGER : Number(interval.endOffsetMs),
  }));

  return segments.map((segment) => {
    const overlaps = new Map();

    for (const row of rows) {
      const overlap =
        Math.min(segment.endMs, row.endMs) - Math.max(segment.startMs, row.startMs);
      if (overlap <= 0) continue;

      const key = row.userId ?? `discord:${row.discordUserId}`;
      const current = overlaps.get(key) || { userId: row.userId, discordUserId: row.discordUserId, ms: 0 };
      current.ms += overlap;
      overlaps.set(key, current);
    }

    if (overlaps.size === 0) return { ...segment, speakerUserId: null, speakerDiscordId: null };

    const ranked = [...overlaps.values()].sort((a, b) => b.ms - a.ms);
    if (ranked.length > 1 && ranked[0].ms === ranked[1].ms) {
      return { ...segment, speakerUserId: null, speakerDiscordId: null };
    }

    return {
      ...segment,
      speakerUserId: ranked[0].userId ?? null,
      speakerDiscordId: ranked[0].discordUserId ?? null,
    };
  });
}

// ============================================================================
// Providers
// ============================================================================

/**
 * Hosted Whisper.  `timestamp_granularities[]=word` is what makes a transcript
 * line clickable — without it the response has segments only, and a click can
 * seek no more precisely than the paragraph.
 */
async function transcribeWithOpenAi(filePath) {
  const apiKey = process.env.OPENAI_API_KEY || transcriptionConfig().apiKey;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set; cannot transcribe.");

  const model = transcriptionConfig().model || "whisper-1";

  // FormData/Blob are global from Node 18; the file is streamed in rather than
  // read whole, because a meeting recording is not a small file.
  const form = new FormData();
  const info = await stat(filePath);
  form.append("file", await fileBlob(filePath, info.size), path.basename(filePath));
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Whisper API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = await response.json();

  return {
    text: payload.text || "",
    segments: (payload.segments || []).map((segment) => ({
      startMs: Math.round((segment.start || 0) * 1000),
      endMs: Math.round((segment.end || 0) * 1000),
      text: segment.text || "",
    })),
    words: (payload.words || []).map((word) => ({
      word: word.word,
      startMs: Math.round((word.start || 0) * 1000),
      endMs: Math.round((word.end || 0) * 1000),
    })),
  };
}

/** Node's fetch wants a Blob; this keeps the read lazy rather than slurping. */
async function fileBlob(filePath, size) {
  const chunks = [];
  for await (const chunk of createReadStream(filePath)) chunks.push(chunk);
  return new Blob([Buffer.concat(chunks)], { type: "application/octet-stream" });
}

/**
 * A local whisper binary, invoked in a child process — this process serves HTTP
 * and runs the bot, and a transcription run is minutes of solid CPU.
 *
 * Output is read from the JSON file the binary writes, which both whisper.cpp
 * and openai-whisper produce with `--output_format json`.
 */
async function transcribeWithCli(filePath) {
  const binary = transcriptionConfig().binary || "whisper";
  const model = transcriptionConfig().model || "base.en";
  const outDir = await mkdtemp(path.join(tmpdir(), "zander-whisper-"));

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        [
          filePath,
          "--model",
          model,
          "--output_format",
          "json",
          "--word_timestamps",
          "True",
          "--output_dir",
          outDir,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 8192) stderr += chunk.toString();
      });

      child.on("error", (error) => reject(new Error(`Could not run ${binary}: ${error.message}`)));
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`${binary} exited ${code}: ${stderr.slice(-400)}`))
      );
    });

    const jsonPath = path.join(outDir, `${path.parse(filePath).name}.json`);
    const payload = JSON.parse(await (await import("fs/promises")).readFile(jsonPath, "utf8"));

    const segments = (payload.segments || []).map((segment) => ({
      startMs: Math.round((segment.start || 0) * 1000),
      endMs: Math.round((segment.end || 0) * 1000),
      text: segment.text || "",
    }));

    const words = (payload.segments || []).flatMap((segment) =>
      (segment.words || []).map((word) => ({
        word: word.word ?? word.text,
        startMs: Math.round((word.start || 0) * 1000),
        endMs: Math.round((word.end || 0) * 1000),
      }))
    );

    return { text: payload.text || segments.map((s) => s.text).join(" "), segments, words };
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeFile(filePath) {
  switch (transcriptionProvider()) {
    case "openai":
      return transcribeWithOpenAi(filePath);
    case "whisper-cli":
      return transcribeWithCli(filePath);
    default:
      throw new Error("Transcription is disabled (config.meetings.transcription.provider).");
  }
}

/**
 * Pull a stored asset down to a scratch file.
 *
 * Streamed to disk, never into memory: this is the same recording the recorder
 * refused to buffer, and it has not got smaller since.
 */
async function fetchToScratch(storagePath, storagePublicId, dir, name) {
  const target = path.join(dir, name);

  // A local path (no Cloudinary configured) is already on disk.
  if (!storagePublicId && !/^https?:\/\//i.test(storagePath)) return storagePath;

  const url = storagePublicId && isCloudinaryConfigured()
    ? signedAssetUrl(storagePublicId)
    : storagePath;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch audio (${response.status})`);

  const { pipeline } = await import("stream/promises");
  const { createWriteStream } = await import("fs");
  await pipeline(response.body, createWriteStream(target));

  return target;
}

// ============================================================================
// Work units
// ============================================================================

/**
 * Transcribe one recording and store the result.
 *
 * The transcript is written as a VTT file alongside the audio, and the cue
 * times are SESSION offsets — Whisper's file-relative times plus the
 * recording's `startOffsetMs`.  That conversion happens here and nowhere else,
 * so a transcript from the second recording of a reconnected meeting still
 * lines up with the agenda stamps and the comment track.
 */
export async function transcribeRecording(recordingId) {
  const id = parseInt(recordingId);
  const recording = await prisma.meetingRecordings.findUnique({ where: { recordingId: id } });
  if (!recording) throw new Error("Recording not found.");
  if (!recording.storagePath) throw new Error("This recording has no audio to transcribe.");

  await prisma.meetingRecordings.update({
    where: { recordingId: id },
    data: { transcriptStatus: TRANSCRIPT_STATUS.RUNNING, transcriptError: null },
  });

  const dir = await mkdtemp(path.join(tmpdir(), "zander-transcribe-"));

  try {
    const localPath = await fetchToScratch(
      recording.storagePath,
      recording.storagePublicId,
      dir,
      `recording-${id}.ogg`
    );

    const result = await transcribeFile(localPath);
    const startOffsetMs = Number(recording.startOffsetMs || 0);

    // File-relative -> session timeline.  The one conversion point.
    const segments = result.segments.map((segment) => ({
      ...segment,
      startMs: segment.startMs + startOffsetMs,
      endMs: segment.endMs + startOffsetMs,
    }));
    const words = result.words.map((word) => ({
      ...word,
      startMs: word.startMs + startOffsetMs,
      endMs: word.endMs + startOffsetMs,
    }));

    const intervals = await prisma.meetingSpeakingIntervals.findMany({
      where: { sessionId: recording.sessionId },
    });
    const attributed = attributeSegments(segments, intervals);

    const speakerNames = await loadSpeakerNames(attributed);
    const vtt = toVtt(attributed, { speakerNames });

    const transcriptPath = path.join(dir, `recording-${id}.vtt`);
    await writeFile(transcriptPath, vtt, "utf8");

    let storedPath = transcriptPath;
    let storedPublicId = null;

    if (isCloudinaryConfigured()) {
      const { uploadArchiveFile } = await import("./cloudinaryService.js");
      // `raw`, and authenticated like the audio: a transcript of a staff meeting
      // is exactly as sensitive as the recording it came from, so it is signed
      // per request rather than left readable to anyone holding the link — which
      // is why the public_id has to be kept alongside the URL.
      const uploaded = await uploadArchiveFile(transcriptPath);
      storedPath = uploaded.url;
      storedPublicId = uploaded.publicId;
    }

    await prisma.meetingRecordings.update({
      where: { recordingId: id },
      data: {
        transcriptStatus: TRANSCRIPT_STATUS.DONE,
        transcriptPath: storedPath.slice(0, 512),
        transcriptPublicId: storedPublicId,
      },
    });

    return { segments: attributed, words, vtt, transcriptPath: storedPath };
  } catch (error) {
    await prisma.meetingRecordings.update({
      where: { recordingId: id },
      data: {
        transcriptStatus: TRANSCRIPT_STATUS.FAILED,
        transcriptError: String(error?.message ?? error).slice(0, 2000),
      },
    });
    throw error;
  } finally {
    // Only ever the scratch copy: a local-storage deployment's own file is
    // outside this directory and is never touched.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transcribe one voice-note comment.
 *
 * Stored as plain text on the comment rather than as a VTT file: a
 * thirty-second note needs no cue timings, and having the words in a column
 * means voice notes turn up in the same search as everything else — which is
 * the difference between a voice note being useful and being a thing nobody
 * ever plays.
 */
export async function transcribeVoiceComment(commentId) {
  const id = parseInt(commentId);
  const comment = await prisma.meetingComments.findUnique({ where: { commentId: id } });
  if (!comment) throw new Error("Comment not found.");
  if (!comment.audioPath) throw new Error("This comment has no audio.");

  await prisma.meetingComments.update({
    where: { commentId: id },
    data: { transcriptStatus: TRANSCRIPT_STATUS.RUNNING },
  });

  const dir = await mkdtemp(path.join(tmpdir(), "zander-voicenote-tx-"));

  try {
    const localPath = await fetchToScratch(
      comment.audioPath,
      comment.audioPublicId,
      dir,
      `comment-${id}.ogg`
    );

    const result = await transcribeFile(localPath);

    await prisma.meetingComments.update({
      where: { commentId: id },
      data: { transcript: result.text.trim() || null, transcriptStatus: TRANSCRIPT_STATUS.DONE },
    });

    return result;
  } catch (error) {
    await prisma.meetingComments.update({
      where: { commentId: id },
      data: { transcriptStatus: TRANSCRIPT_STATUS.FAILED },
    });
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** userId -> username, for speaker labels on the transcript. */
async function loadSpeakerNames(segments) {
  const userIds = [...new Set(segments.map((s) => s.speakerUserId).filter((id) => id != null))];
  if (userIds.length === 0) return new Map();

  const users = await prisma.users.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, username: true },
  });

  return new Map(users.map((user) => [user.userId, user.username]));
}

/** Work waiting for the cron: recordings first, then voice notes. */
export async function pendingTranscriptionWork(limit = 5) {
  const [recordings, comments] = await Promise.all([
    prisma.meetingRecordings.findMany({
      where: { transcriptStatus: TRANSCRIPT_STATUS.PENDING, storagePath: { not: "" } },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
    prisma.meetingComments.findMany({
      where: { transcriptStatus: TRANSCRIPT_STATUS.PENDING, kind: "voice", deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
  ]);

  return { recordings, comments };
}
