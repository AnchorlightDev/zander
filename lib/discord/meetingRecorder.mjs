/**
 * lib/discord/meetingRecorder.mjs
 *
 * Captures a Discord voice or stage channel and files the result as a
 * `source = 'discord_bot'` recording on a meeting session.
 *
 * The bot shares this process with the web app (see app.js), so this calls the
 * service layer directly rather than going out over HTTP to its own API — the
 * same shared-controller pattern the rest of the codebase uses.
 *
 * ANCHOR RULE: offsets written to the database are milliseconds from
 * `meetingSessions`.`startedAt`.  Offsets *inside* a scratch track are local to
 * the recording, because the recording row's own `startOffsetMs` is what places
 * the file on the session timeline.  The conversion happens in exactly one
 * place — localOffsetMs() — and nowhere else.
 *
 * Three things here are easy to get wrong and silent when you do:
 *
 *   1. joinVoiceChannel defaults to selfDeaf: true, which produces a recording
 *      of perfect silence and no error anywhere.
 *   2. A receive stream only emits while someone is actually speaking, so
 *      concatenating bursts deletes every pause and desynchronises every
 *      speaker from every other speaker and from the agenda stamps.
 *   3. Encoding in-process would block the event loop, and this process is also
 *      serving every HTTP request.
 *
 * Each is addressed below, at the line where it matters.
 */

import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { mkdir, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { Colors, EmbedBuilder } from "discord.js";

import {
  PCM_BYTES_PER_MS,
  offsetForBytes,
  paddingBytesFor,
} from "../meetings/timeline.mjs";
import {
  addRecording,
  closeSpeakingInterval,
  endSession,
  getSession,
  logSpeakingInterval,
  markAttendedLive,
  publishSession,
  startSession,
} from "../../services/meetingSessionService.js";

const require = createRequire(import.meta.url);
const config = require("../../config.json");

/** How long a speaker has to be quiet before their burst is closed. */
const SILENCE_END_MS = 1000;

/** One reusable block of zeroes; padding is written from it in chunks so a long
 *  silence never allocates a buffer proportional to its own length. */
const ZERO_CHUNK = Buffer.alloc(64 * 1024);

/** Opus bitrate for the mixdown.  Speech at 64k is transparent enough and keeps
 *  a 90 minute meeting to roughly 40 MB. */
const MIXDOWN_BITRATE = "64k";

/** Live recorders, keyed by sessionId.  One meeting, one recorder. */
const recorders = new Map();

function meetingsConfig() {
  return config.meetings || {};
}

function scratchRoot() {
  return meetingsConfig().scratchDir || path.join(os.tmpdir(), "zander-meetings");
}

function ffmpegBinary() {
  return meetingsConfig().ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
}

/**
 * Voice support is an optional install (@discordjs/voice, prism-media,
 * sodium-native).  Imported lazily and reported plainly, so a deployment
 * without them fails at "start recording" with a fixable message rather than
 * crashing the whole app at boot.
 */
async function loadVoiceStack() {
  try {
    const [voice, prism] = await Promise.all([import("@discordjs/voice"), import("prism-media")]);
    return { voice, prism: prism.default ?? prism };
  } catch (error) {
    throw new Error(
      "Voice recording needs @discordjs/voice, prism-media and sodium-native installed, " +
        `plus an ffmpeg binary on the host (${error.message}).`
    );
  }
}

// ============================================================================
// Announcement — a hard gate, not a courtesy
// ============================================================================

function announcementEmbed(session, channel) {
  return new EmbedBuilder()
    .setTitle("🔴 This meeting is being recorded")
    .setDescription(
      [
        `Audio in **${channel?.name ?? "this channel"}** is being captured so people who could not make it can catch up.`,
        "",
        "• The recording, the agenda and the minutes go to the meeting page on the website.",
        "• Ask the chair for `/meeting pause` at any point and capture stops until it is resumed.",
        "• Ask to be excluded and your audio is dropped — you can stay in the meeting.",
      ].join("\n")
    )
    .setFooter({ text: "Recording started" })
    .setTimestamp(new Date())
    .setColor(Colors.Red);
}

/**
 * Tell the room, before a single byte is captured.
 *
 * Posts to the voice channel's own text chat, falling back to
 * `config.meetings.announceChannelId`.  If neither can be delivered this throws
 * and nothing is recorded.
 *
 * That is deliberate and it is not negotiable: consent rules differ across
 * AU/EU/US and the EU side is strict, and a recording nobody was told about is
 * not worth having even where it happens to be lawful.  Failing to record is
 * recoverable; recording people who were never told is not.
 */
async function announceOrAbort(client, voiceChannel, session) {
  const targets = [];

  // A Discord voice channel has its own text chat; that is where the people in
  // the call actually are.
  if (voiceChannel?.isTextBased?.()) targets.push(voiceChannel);

  const fallbackId = meetingsConfig().announceChannelId;
  if (fallbackId) {
    const fallback = await client.channels.fetch(fallbackId).catch(() => null);
    if (fallback?.isTextBased?.()) targets.push(fallback);
  }

  const embed = announcementEmbed(session, voiceChannel);
  const failures = [];

  for (const target of targets) {
    try {
      const message = await target.send({ embeds: [embed] });
      return { channelId: target.id, messageId: message.id };
    } catch (error) {
      failures.push(`${target.id}: ${error.message}`);
    }
  }

  throw new Error(
    "Refusing to record: the recording notice could not be delivered to anyone. " +
      (failures.length
        ? `Tried ${failures.join("; ")}.`
        : "No voice-channel text chat and no config.meetings.announceChannelId.")
  );
}

// ============================================================================
// Recorder
// ============================================================================

class MeetingRecorder {
  /**
   * @param {object} args
   * @param {number} args.sessionId
   * @param {Date}   args.sessionStartedAt  the module-wide offset origin
   * @param {number} args.startOffsetMs     where this recording sits on the
   *                                        session timeline.  Non-zero for the
   *                                        second recording after a reconnect.
   */
  constructor({ client, sessionId, sessionStartedAt, startOffsetMs, guildId, channelId, actorId }) {
    this.client = client;
    this.sessionId = sessionId;
    this.sessionStartedAt = new Date(sessionStartedAt);
    this.startOffsetMs = startOffsetMs;
    this.guildId = guildId;
    this.channelId = channelId;
    this.actorId = actorId;

    this.connection = null;
    this.voice = null;
    this.prism = null;

    this.paused = false;
    this.stopping = false;
    this.stoppedAt = null;

    /** discordUserId -> { filePath, stream, bytesWritten, index, active } */
    this.tracks = new Map();
    this.trackCount = 0;

    /** discordUserId -> intervalId, for the speaking rows still open. */
    this.openIntervals = new Map();

    /** Discord ids whose audio is dropped at the receive stage. */
    this.excluded = new Set(
      (meetingsConfig().excludedUserIds || []).map((value) => String(value))
    );

    this.dir = path.join(scratchRoot(), `session-${sessionId}-${Date.now()}`);
    this.mixdownPath = path.join(this.dir, "mixdown.ogg");
  }

  // ── Timeline ────────────────────────────────────────────────────────────

  /** Milliseconds from `meetingSessions`.`startedAt`. */
  currentOffsetMs(now = Date.now()) {
    return Math.max(0, now - this.sessionStartedAt.getTime());
  }

  /**
   * Milliseconds from the start of *this recording's* files.  The one place the
   * session timeline is converted to a file position; everything downstream of
   * here works in file-local terms, and the recording row's `startOffsetMs`
   * puts it back on the session timeline.
   */
  localOffsetMs(now = Date.now()) {
    return Math.max(0, this.currentOffsetMs(now) - this.startOffsetMs);
  }

  get isRecording() {
    return Boolean(this.connection) && !this.stopping;
  }

  // ── Tracks ──────────────────────────────────────────────────────────────

  trackFor(discordUserId) {
    const existing = this.tracks.get(discordUserId);
    if (existing) return existing;

    const index = this.trackCount++;
    const filePath = path.join(this.dir, `speaker-${discordUserId}.pcm`);

    const track = {
      discordUserId,
      index,
      filePath,
      stream: createWriteStream(filePath),
      bytesWritten: 0,
      active: false,
    };

    track.stream.on("error", (error) =>
      console.error(`[meetingRecorder] track write failed for ${discordUserId}:`, error.message)
    );

    this.tracks.set(discordUserId, track);
    return track;
  }

  /**
   * Write silence until the track reaches an absolute byte position.
   *
   * Absolute, not incremental, and that is the whole trick.  Each call asks
   * only "how far short of where I should be is this track?", so a burst that
   * was dropped, arrived late or was written short is absorbed by the next call
   * instead of accumulating.  An incremental `elapsed - lastElapsed` scheme
   * compounds every one of those errors, and the drift only becomes visible
   * forty minutes in, when the agenda stamps no longer match the audio.
   */
  padTrackTo(track, targetLocalOffsetMs) {
    let remaining = paddingBytesFor(track.bytesWritten, targetLocalOffsetMs);
    if (remaining <= 0) return 0;

    const padded = remaining;
    while (remaining > 0) {
      const size = Math.min(remaining, ZERO_CHUNK.length);
      track.stream.write(size === ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, size));
      remaining -= size;
    }

    track.bytesWritten += padded;
    return padded;
  }

  /** Pad every track out to the same length, so the mix lines up at the end. */
  padAllTracksTo(targetLocalOffsetMs) {
    for (const track of this.tracks.values()) this.padTrackTo(track, targetLocalOffsetMs);
  }

  // ── Capture ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to one speaker's burst.
   *
   * `EndBehaviorType.AfterSilence` closes the stream once they stop, which is
   * what makes one burst one unit of work — and what makes the padding above
   * necessary, because the gaps between bursts are simply not delivered.
   */
  onSpeakingStart(discordUserId) {
    if (!this.isRecording) return;

    // Checked here, at the receive stage, rather than by refusing to record the
    // meeting: one person declining must not cost everyone else the recording.
    if (this.excluded.has(String(discordUserId))) return;

    // Paused: no subscription, but the timeline keeps running.  Nothing is
    // captured and the padding on the next burst covers the gap on its own,
    // because it is computed from the absolute position.
    if (this.paused) return;

    const track = this.trackFor(discordUserId);
    if (track.active) return;
    track.active = true;

    const startedLocalMs = this.localOffsetMs();
    const startedSessionMs = this.currentOffsetMs();

    // Silence first, audio second — so this burst lands where it belongs.
    this.padTrackTo(track, startedLocalMs);

    const opusStream = this.connection.receiver.subscribe(discordUserId, {
      end: { behavior: this.voice.EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });

    // Opus frames -> 48 kHz stereo signed 16-bit LE, which is what the padding
    // maths and the ffmpeg input format below both assume.
    const decoder = new this.prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    decoder.on("data", (chunk) => {
      track.bytesWritten += chunk.length;
      track.stream.write(chunk);
    });

    const finish = () => {
      if (!track.active) return;
      track.active = false;
      this.closeInterval(discordUserId);
    };

    decoder.on("error", (error) => {
      console.warn(`[meetingRecorder] decode error for ${discordUserId}:`, error.message);
      finish();
    });
    opusStream.on("error", (error) => {
      console.warn(`[meetingRecorder] receive error for ${discordUserId}:`, error.message);
      finish();
    });
    opusStream.on("end", finish);

    opusStream.pipe(decoder);

    this.openInterval(discordUserId, startedSessionMs);

    // Attendance, from the fact that they spoke.  Attendance only — it never
    // touches their role, because a role decides what they can read.
    markAttendedLive({ sessionId: this.sessionId, discordUserId }).catch(() => {});
  }

  openInterval(discordUserId, startOffsetMs) {
    logSpeakingInterval({ sessionId: this.sessionId, discordUserId, startOffsetMs })
      .then((row) => {
        // The burst may already have ended by the time the insert lands; close
        // it immediately rather than leaving an interval open forever.
        if (!this.tracks.get(discordUserId)?.active) {
          return closeSpeakingInterval(row.intervalId, this.currentOffsetMs());
        }
        this.openIntervals.set(discordUserId, row.intervalId);
        return null;
      })
      .catch((error) =>
        console.warn("[meetingRecorder] speaking interval insert failed:", error.message)
      );
  }

  closeInterval(discordUserId) {
    const intervalId = this.openIntervals.get(discordUserId);
    if (!intervalId) return;
    this.openIntervals.delete(discordUserId);

    closeSpeakingInterval(intervalId, this.currentOffsetMs()).catch((error) =>
      console.warn("[meetingRecorder] speaking interval close failed:", error.message)
    );
  }

  // ── Pause ───────────────────────────────────────────────────────────────

  /**
   * Stop capturing but keep the clock.
   *
   * The announcement embed promises this, so it has to exist and it has to
   * actually stop audio reaching disk.  The timeline is unaffected: padding is
   * computed from the absolute position, so the pause simply shows up as
   * silence of exactly the right length once recording resumes.
   */
  pause() {
    if (this.paused) return false;
    this.paused = true;

    for (const [discordUserId, track] of this.tracks) {
      if (track.active) {
        track.active = false;
        this.closeInterval(discordUserId);
      }
    }

    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    return true;
  }

  // ── Stop, mix, upload ───────────────────────────────────────────────────

  /**
   * Finish the recording.
   *
   * The cleanup order is dictated by what has been persisted, at every step:
   *
   *   1. scratch PCM is deleted only once the mixdown exists;
   *   2. the mixdown is deleted only once the upload has returned a URL *and*
   *      that URL has been written to the database.
   *
   * A failure anywhere therefore leaves files on disk to recover by hand.  The
   * alternative — cleaning up eagerly — turns one bad upload into a meeting
   * nobody can ever listen to again.
   */
  async stop({ reason = "stopped" } = {}) {
    if (this.stopping) return null;
    this.stopping = true;
    this.stoppedAt = new Date();

    const durationLocalMs = this.localOffsetMs(this.stoppedAt.getTime());

    // Everything to the same length, so the mix does not end raggedly and the
    // last speaker's track is not short.
    this.padAllTracksTo(durationLocalMs);

    for (const discordUserId of [...this.openIntervals.keys()]) this.closeInterval(discordUserId);

    await Promise.all([...this.tracks.values()].map((track) => closeStream(track.stream)));

    try {
      this.connection?.destroy();
    } catch {
      /* already gone */
    }
    this.connection = null;
    recorders.delete(this.sessionId);

    const tracks = [...this.tracks.values()].filter((track) => track.bytesWritten > 0);

    if (tracks.length === 0) {
      console.warn(`[meetingRecorder] session ${this.sessionId}: nothing captured (${reason})`);
      await rm(this.dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    let recording = null;

    try {
      await mixdown(tracks, this.mixdownPath, durationLocalMs);

      // Step 1: the mixdown exists, so the raw PCM is now redundant.  It is also
      // enormous — ~11.5 MB per minute per speaker — so it goes first.
      await Promise.all(tracks.map((track) => rm(track.filePath, { force: true }).catch(() => {})));

      const info = await stat(this.mixdownPath);
      const { isCloudinaryConfigured, uploadAudioFile } = await import(
        "../../services/cloudinaryService.js"
      );

      if (isCloudinaryConfigured()) {
        const uploaded = await uploadAudioFile(this.mixdownPath);

        recording = await addRecording({
          sessionId: this.sessionId,
          source: "discord_bot",
          storagePath: uploaded.url,
          storagePublicId: uploaded.publicId,
          mimeType: "audio/ogg",
          byteSize: uploaded.bytes ?? info.size,
          durationMs: uploaded.durationMs ?? durationLocalMs,
          startOffsetMs: this.startOffsetMs,
          discordGuildId: this.guildId,
          discordChannelId: this.channelId,
        });

        // Step 2, and only now: the URL is in the database, so the local copy
        // is genuinely redundant.
        await rm(this.dir, { recursive: true, force: true }).catch(() => {});
      } else {
        // No Cloudinary (a dev box): keep the file and register the local path,
        // so the session is still playable rather than silently empty.
        recording = await addRecording({
          sessionId: this.sessionId,
          source: "discord_bot",
          storagePath: this.mixdownPath,
          storagePublicId: null,
          mimeType: "audio/ogg",
          byteSize: info.size,
          durationMs: durationLocalMs,
          startOffsetMs: this.startOffsetMs,
          discordGuildId: this.guildId,
          discordChannelId: this.channelId,
        });
      }
    } catch (error) {
      console.error(
        `[meetingRecorder] session ${this.sessionId}: mixdown/upload failed, files kept at ${this.dir}:`,
        error?.message ?? error
      );
      return null;
    }

    return recording;
  }
}

// ============================================================================
// ffmpeg
// ============================================================================

function closeStream(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

/**
 * Mix the per-speaker tracks into one opus-in-ogg file, in a child process.
 *
 * A child process, not a library call: this process also serves every HTTP
 * request and runs the Discord bot, and encoding an hour of audio in-thread
 * would stall Fastify for the duration.
 *
 * `amix` with `normalize=0` keeps each speaker at their own level instead of
 * dividing everyone by the number of inputs — otherwise a meeting with six
 * tracks comes out six times too quiet.  `loudnorm` then brings the whole thing
 * to a consistent level, which matters when one person is on a headset and
 * another is across the room from a laptop mic.
 */
function mixdown(tracks, outputPath, durationMs) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];

  for (const track of tracks) {
    // Raw PCM carries no header, so the format has to be declared per input —
    // and it has to match what the padding maths assumed.
    args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-i", track.filePath);
  }

  const filter =
    tracks.length > 1
      ? `amix=inputs=${tracks.length}:duration=longest:normalize=0,loudnorm`
      : "loudnorm";

  args.push(
    "-filter_complex",
    `${filter}[out]`,
    "-map",
    "[out]",
    "-c:a",
    "libopus",
    "-b:a",
    MIXDOWN_BITRATE,
    "-vn",
    outputPath
  );

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      // Bounded: a failing ffmpeg can produce a great deal of output, and this
      // is only ever read to put a line in an error message.
      if (stderr.length < 8192) stderr += chunk.toString();
    });

    child.on("error", (error) =>
      reject(new Error(`Could not run ffmpeg (${ffmpegBinary()}): ${error.message}`))
    );

    child.on("close", (code) => {
      if (code === 0) return resolve({ outputPath, durationMs });
      reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

// ============================================================================
// Public API
// ============================================================================

export function getRecorder(sessionId) {
  return recorders.get(parseInt(sessionId)) || null;
}

export function isRecording(sessionId) {
  return Boolean(getRecorder(sessionId)?.isRecording);
}

/** Where the meeting is on its own timeline, for command guards and stamping. */
export function currentOffsetMs(sessionId) {
  const recorder = getRecorder(sessionId);
  return recorder ? recorder.currentOffsetMs() : null;
}

export function excludeUser(sessionId, discordUserId) {
  const recorder = getRecorder(sessionId);
  if (!recorder) return false;
  recorder.excluded.add(String(discordUserId));
  return true;
}

export function includeUser(sessionId, discordUserId) {
  const recorder = getRecorder(sessionId);
  if (!recorder) return false;
  return recorder.excluded.delete(String(discordUserId));
}

export function pauseRecording(sessionId) {
  const recorder = getRecorder(sessionId);
  if (!recorder) throw new Error("Nothing is being recorded for this meeting.");
  return recorder.pause();
}

export function resumeRecording(sessionId) {
  const recorder = getRecorder(sessionId);
  if (!recorder) throw new Error("Nothing is being recorded for this meeting.");
  return recorder.resume();
}

/**
 * Join a voice or stage channel and start capturing.
 *
 * Order matters: announce, then start the session, then join.  Nothing is
 * captured before the room has been told.
 */
export async function startRecording({ client, sessionId, eventId = null, voiceChannel, actorId = null }) {
  const { voice, prism } = await loadVoiceStack();

  const existing = recorders.get(parseInt(sessionId));
  if (existing?.isRecording) throw new Error("This meeting is already being recorded.");

  if (!voiceChannel?.guild) throw new Error("A voice or stage channel is required.");

  const sessionRow = await getSession(sessionId);
  if (!sessionRow) throw new Error("Meeting session not found.");

  // The gate.  Throws — and records nothing — if the notice cannot be delivered.
  await announceOrAbort(client, voiceChannel, sessionRow);

  // startSession writes `startedAt` exactly once; a rejoin gets the original
  // back, which is what makes the second recording's startOffsetMs meaningful.
  const { session, resumed } = await startSession({
    sessionId: sessionRow.sessionId,
    eventId,
    actorId,
  });

  const startOffsetMs = resumed
    ? Math.max(0, Date.now() - new Date(session.startedAt).getTime())
    : 0;

  const recorder = new MeetingRecorder({
    client,
    sessionId: session.sessionId,
    sessionStartedAt: session.startedAt,
    startOffsetMs,
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    actorId,
  });

  recorder.voice = voice;
  recorder.prism = prism;

  await mkdir(recorder.dir, { recursive: true });

  recorder.connection = voice.joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    // The default is true, and a self-deafened bot receives nothing at all:
    // a full-length recording of perfect silence, with no error anywhere to
    // explain it.  This single flag is the difference.
    selfDeaf: false,
    selfMute: true,
  });

  recorders.set(session.sessionId, recorder);

  try {
    await voice.entersState(recorder.connection, voice.VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    recorder.connection.destroy();
    recorders.delete(session.sessionId);
    await rm(recorder.dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Could not join the voice channel: ${error.message}`);
  }

  recorder.connection.receiver.speaking.on("start", (discordUserId) =>
    recorder.onSpeakingStart(discordUserId)
  );

  attachDisconnectHandling(recorder, voice);

  return { recorder, session, startOffsetMs, resumed };
}

/**
 * A dropped connection is either a Discord-side voice-region move — which
 * reconnects by itself within a few seconds — or a real disconnect.
 *
 * On a real one the recording is stopped and whatever exists is filed.  A later
 * rejoin calls startRecording() again and produces a *second* recording row at
 * a non-zero `startOffsetMs`, rather than reopening and corrupting the first.
 * That is why several recordings per session is the normal case and not an
 * error case.
 */
function attachDisconnectHandling(recorder, voice) {
  recorder.connection.on(voice.VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        voice.entersState(recorder.connection, voice.VoiceConnectionStatus.Signalling, 5_000),
        voice.entersState(recorder.connection, voice.VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Moving between voice regions; the connection recovers on its own and
      // the timeline is untouched, because it is anchored to the wall clock.
    } catch {
      console.warn(
        `[meetingRecorder] session ${recorder.sessionId}: voice connection lost, filing what we have`
      );
      await recorder.stop({ reason: "disconnected" }).catch((error) =>
        console.error("[meetingRecorder] stop after disconnect failed:", error?.message ?? error)
      );
    }
  });
}

/**
 * Stop recording and close the meeting out.
 *
 * `publish` moves the session on to `published` once the audio is filed; a stop
 * that captured nothing leaves it in `processing`, where the organiser can see
 * that something went wrong instead of being shown an empty published meeting.
 */
export async function stopRecording({ sessionId, publish = true }) {
  const recorder = getRecorder(sessionId);
  if (!recorder) throw new Error("Nothing is being recorded for this meeting.");

  const durationMs = recorder.currentOffsetMs();
  const recording = await recorder.stop({ reason: "stopped" });

  await endSession({ sessionId: recorder.sessionId, durationMs });

  if (publish && recording) {
    const deadlineDays = Number(meetingsConfig().responseDeadlineDays);
    const responseDeadlineAt = Number.isFinite(deadlineDays) && deadlineDays > 0
      ? new Date(Date.now() + deadlineDays * 86_400_000)
      : undefined;

    await publishSession(recorder.sessionId, { responseDeadlineAt });
  }

  return { recording, durationMs };
}

export { PCM_BYTES_PER_MS, offsetForBytes };
