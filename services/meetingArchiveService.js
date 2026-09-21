/**
 * Meeting Archive Service
 *
 * Builds the export bundle for a meeting session: a single zip holding
 * everything needed to reconstruct the meeting with no database at all.
 *
 * The bundle is the answer to "what happens when this app is gone", so it is
 * deliberately built out of plain formats — ogg, vtt, txt, markdown, json — and
 * carries a `metadata.json` with the full timeline in it.  A zip of audio with
 * no index is an archive nobody can use in five years.
 *
 * Always built by the cron, never in a request (see cron/meetingArchiveCron.js),
 * and always streamed: a meeting's audio is hundreds of megabytes and this
 * process is also serving HTTP.
 */

import { createWriteStream } from "fs";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import fetch from "node-fetch";

import { prisma } from "../controllers/databaseController.js";
import {
  ARCHIVE_STATUS,
  assertArchiveTransition,
} from "../lib/meetings/archiveState.mjs";
import { normaliseRecordings } from "../lib/meetings/timeline.mjs";
import {
  isCloudinaryConfigured,
  signedAssetUrl,
  uploadArchiveFile,
} from "./cloudinaryService.js";

/** Optional dependency, reported plainly rather than crashing the app at boot. */
async function loadArchiver() {
  try {
    const module = await import("archiver");
    return module.default ?? module;
  } catch (error) {
    throw new Error(`Archive building needs the "archiver" package installed (${error.message}).`);
  }
}

function formatOffset(ms) {
  if (ms == null) return "—";
  const total = Math.floor(Number(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function safeName(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return cleaned || fallback;
}

// ============================================================================
// Rendered documents
// ============================================================================

/**
 * Agenda and minutes as markdown.
 *
 * Every note is included regardless of its visibility or reveal mode — this is
 * the organiser's archive of their own meeting, and an archive that quietly
 * drops the speakers-only minutes is worse than no archive.  Each note carries
 * its visibility in the text, so whoever reads it later knows what it was.
 */
export function renderMinutesMarkdown({ session, event, agendaItems, notes, attendees, userNames }) {
  const lines = [];
  const name = (userId) => userNames.get(userId) || `User #${userId}`;

  lines.push(`# ${event?.title || `Meeting session #${session.sessionId}`}`, "");
  lines.push(`- **Session:** #${session.sessionId}`);
  if (session.startedAt) lines.push(`- **Started:** ${new Date(session.startedAt).toISOString()}`);
  if (session.endedAt) lines.push(`- **Ended:** ${new Date(session.endedAt).toISOString()}`);
  if (session.durationMs) lines.push(`- **Duration:** ${formatOffset(session.durationMs)}`);
  // ISO 8601 throughout, in UTC.  Everywhere a human reads a time in this app
  // it is rendered in their own timezone client-side, which a text file cannot
  // do — so the archive stores the unambiguous form and lets the reader convert.
  lines.push("", "_All times are UTC (ISO 8601). Offsets are from the start of the meeting._", "");

  if (session.summary) lines.push("## Summary", "", session.summary, "");

  lines.push("## Attendees", "");
  if (attendees.length === 0) lines.push("_No roster recorded._", "");
  for (const attendee of attendees) {
    lines.push(
      `- ${name(attendee.userId)} — ${attendee.role}${attendee.attendedLive ? " (attended live)" : ""}`
    );
  }
  lines.push("");

  lines.push("## Agenda", "");
  if (agendaItems.length === 0) lines.push("_No agenda._", "");

  for (const item of agendaItems) {
    const stamp =
      item.startOffsetMs == null
        ? "not discussed"
        : `${formatOffset(item.startOffsetMs)}–${formatOffset(item.endOffsetMs)}`;

    lines.push(`### ${item.title}  \n\`${stamp}\` · ${item.status}`, "");
    if (item.brief) lines.push(`> ${item.brief}`, "");

    const itemNotes = notes.filter((note) => note.agendaItemId === item.itemId);
    if (itemNotes.length === 0) {
      lines.push("_No notes recorded._", "");
      continue;
    }

    for (const note of itemNotes) {
      const label = note.kind === "decision" ? "**Decision**" : note.kind === "action" ? "**Action**" : "Note";
      lines.push(`- ${label} (${note.visibility}, ${name(note.authorUserId)}): ${note.body}`);
    }
    lines.push("");
  }

  const generalNotes = notes.filter((note) => note.agendaItemId == null);
  if (generalNotes.length > 0) {
    lines.push("## General notes", "");
    for (const note of generalNotes) {
      lines.push(`- ${note.kind} (${note.visibility}, ${name(note.authorUserId)}): ${note.body}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** The discussion, in timeline order, as markdown. */
export function renderCommentsMarkdown({ comments, userNames }) {
  const name = (userId) => userNames.get(userId) || `User #${userId}`;
  const lines = ["# Discussion", ""];

  if (comments.length === 0) lines.push("_No comments._");

  for (const comment of comments) {
    const at = comment.atOffsetMs == null ? "general" : formatOffset(comment.atOffsetMs);
    const when = comment.postedLive ? "live" : "catch-up";
    lines.push(`### ${name(comment.userId)} · \`${at}\` · ${when} · ${comment.visibility}`);

    if (comment.kind === "voice") {
      lines.push("", `_Voice note — \`voice-notes/comment-${comment.commentId}.ogg\`_`);
      if (comment.transcript) lines.push("", `> ${comment.transcript}`);
    } else {
      lines.push("", comment.body || "");
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * The machine-readable copy of everything.
 *
 * This is what makes the bundle reconstructable without the database: the full
 * timeline, every offset, every id, every visibility and reveal setting.  If
 * only one file in the zip survives, it should be this one.
 */
export function buildMetadata({
  session,
  event,
  agendaItems,
  notes,
  comments,
  attendees,
  recordings,
  speakingIntervals,
  userNames,
}) {
  return {
    schema: "zander.meeting-archive/1",
    generatedAt: new Date().toISOString(),
    // Stated explicitly so a reader in five years does not have to guess what
    // the numbers below are relative to.
    offsetAnchor: "milliseconds from session.startedAt",
    session: {
      sessionId: session.sessionId,
      status: session.status,
      audienceMode: session.audienceMode,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: session.durationMs == null ? null : Number(session.durationMs),
      responseDeadlineAt: session.responseDeadlineAt,
      summary: session.summary,
      noteRevealMode: session.noteRevealMode,
    },
    event: event
      ? {
          eventId: event.eventId,
          title: event.title,
          slug: event.slug,
          startAt: event.startAt,
          endAt: event.endAt,
          timezone: event.timezone,
          internal: event.internal,
          meetingPollId: event.meetingPollId,
        }
      : null,
    users: [...userNames.entries()].map(([userId, username]) => ({ userId, username })),
    attendees: attendees.map((attendee) => ({
      userId: attendee.userId,
      username: userNames.get(attendee.userId) || null,
      role: attendee.role,
      source: attendee.source,
      viaRankSlug: attendee.viaRankSlug,
      attendedLive: attendee.attendedLive,
      removedAt: attendee.removedAt,
    })),
    recordings: recordings.map((recording) => ({
      recordingId: recording.recordingId,
      source: recording.source,
      file: recording.archiveFile,
      mimeType: recording.mimeType,
      startOffsetMs: Number(recording.startOffsetMs),
      durationMs: recording.durationMs == null ? null : Number(recording.durationMs),
      byteSize: recording.byteSize == null ? null : Number(recording.byteSize),
      transcriptStatus: recording.transcriptStatus,
    })),
    agendaItems: agendaItems.map((item) => ({
      itemId: item.itemId,
      title: item.title,
      brief: item.brief,
      orderIndex: item.orderIndex,
      status: item.status,
      startOffsetMs: item.startOffsetMs == null ? null : Number(item.startOffsetMs),
      endOffsetMs: item.endOffsetMs == null ? null : Number(item.endOffsetMs),
    })),
    notes: notes.map((note) => ({
      noteId: note.noteId,
      agendaItemId: note.agendaItemId,
      authorUserId: note.authorUserId,
      kind: note.kind,
      body: note.body,
      visibility: note.visibility,
      revealMode: note.revealMode,
      revealAtOffsetMs: note.revealAtOffsetMs == null ? null : Number(note.revealAtOffsetMs),
      revealAt: note.revealAt,
      createdAt: note.createdAt,
    })),
    comments: comments.map((comment) => ({
      commentId: comment.commentId,
      parentCommentId: comment.parentCommentId,
      agendaItemId: comment.agendaItemId,
      userId: comment.userId,
      kind: comment.kind,
      atOffsetMs: comment.atOffsetMs == null ? null : Number(comment.atOffsetMs),
      body: comment.body,
      transcript: comment.transcript,
      visibility: comment.visibility,
      postedLive: comment.postedLive,
      createdAt: comment.createdAt,
      file: comment.kind === "voice" ? `voice-notes/comment-${comment.commentId}.ogg` : null,
    })),
    speakingIntervals: speakingIntervals.map((interval) => ({
      userId: interval.userId,
      discordUserId: interval.discordUserId,
      startOffsetMs: Number(interval.startOffsetMs),
      endOffsetMs: interval.endOffsetMs == null ? null : Number(interval.endOffsetMs),
    })),
  };
}

// ============================================================================
// Build
// ============================================================================

/** A readable stream for a stored asset, signed if it needs to be. */
async function openAsset(storagePath, storagePublicId, { resourceType = "video" } = {}) {
  if (!storagePath) return null;

  if (!/^https?:\/\//i.test(storagePath)) {
    const { createReadStream } = await import("fs");
    return createReadStream(storagePath);
  }

  const url =
    storagePublicId && isCloudinaryConfigured()
      ? signedAssetUrl(storagePublicId, { resourceType })
      : storagePath;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${storagePath} (${response.status})`);
  return response.body;
}

/**
 * Build the bundle and hand back where it ended up.
 *
 * Everything is appended as a stream, so peak memory is one zip window rather
 * than the size of the meeting.  `archiveStatus` moves requested -> building ->
 * ready|failed through the state machine, which refuses an illegal move rather
 * than letting two builders fight over the same session.
 */
export async function buildArchive(sessionId) {
  const archiver = await loadArchiver();
  const id = parseInt(sessionId);

  const session = await prisma.meetingSessions.findUnique({
    where: { sessionId: id },
    include: { event: true },
  });
  if (!session) throw new Error("Meeting session not found.");

  assertArchiveTransition(session.archiveStatus, ARCHIVE_STATUS.BUILDING);
  await prisma.meetingSessions.update({
    where: { sessionId: id },
    data: { archiveStatus: ARCHIVE_STATUS.BUILDING },
  });

  const dir = await mkdtemp(path.join(tmpdir(), "zander-archive-"));
  const bundleName = `meeting-${id}-${safeName(session.event?.title, "session")}.zip`;
  const bundlePath = path.join(dir, bundleName);

  try {
    const [agendaItems, notes, comments, attendees, recordingRows, speakingIntervals] =
      await Promise.all([
        prisma.meetingAgendaItems.findMany({ where: { sessionId: id }, orderBy: { orderIndex: "asc" } }),
        // Deleted notes are excluded; everything else goes in whatever its
        // visibility, because this is the organiser's own record.
        prisma.meetingNotes.findMany({
          where: { sessionId: id, deletedAt: null },
          orderBy: [{ orderIndex: "asc" }],
        }),
        prisma.meetingComments.findMany({
          where: { sessionId: id, deletedAt: null },
          orderBy: [{ atOffsetMs: "asc" }, { createdAt: "asc" }],
        }),
        prisma.meetingSessionAttendees.findMany({ where: { sessionId: id } }),
        prisma.meetingRecordings.findMany({ where: { sessionId: id }, orderBy: { startOffsetMs: "asc" } }),
        prisma.meetingSpeakingIntervals.findMany({
          where: { sessionId: id },
          orderBy: { startOffsetMs: "asc" },
        }),
      ]);

    const userIds = [
      ...new Set([
        ...attendees.map((a) => a.userId),
        ...notes.map((n) => n.authorUserId),
        ...comments.map((c) => c.userId),
        ...speakingIntervals.map((i) => i.userId).filter((v) => v != null),
      ]),
    ];
    const users = userIds.length
      ? await prisma.users.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, username: true },
        })
      : [];
    const userNames = new Map(users.map((user) => [user.userId, user.username]));

    // Joined by recordingId, not by array position: normaliseRecordings sorts,
    // and the two arrays are only coincidentally in the same order.
    const rowById = new Map(recordingRows.map((row) => [row.recordingId, row]));
    const recordings = normaliseRecordings(recordingRows).map((recording) => ({
      ...rowById.get(recording.recordingId),
      ...recording,
      archiveFile: `audio/recording-${recording.recordingId}.ogg`,
    }));

    const output = createWriteStream(bundlePath);
    const zip = archiver("zip", { zlib: { level: 6 } });

    const finished = new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      zip.on("error", reject);
      // A missing voice note is a warning, not a failed archive: the rest of
      // the bundle is still worth having.
      zip.on("warning", (warning) => console.warn("[meetingArchive]", warning.message));
    });

    zip.pipe(output);

    zip.append(
      renderMinutesMarkdown({ session, event: session.event, agendaItems, notes, attendees, userNames }),
      { name: "minutes.md" }
    );
    zip.append(renderCommentsMarkdown({ comments, userNames }), { name: "discussion.md" });

    for (const recording of recordings) {
      if (recording.storagePath) {
        const stream = await openAsset(recording.storagePath, recording.storagePublicId);
        if (stream) zip.append(stream, { name: recording.archiveFile });
      }

      if (recording.transcriptPath) {
        const transcript = await openAsset(recording.transcriptPath, recording.transcriptPublicId, {
          resourceType: "raw",
        });
        if (transcript) {
          zip.append(transcript, { name: `transcript/recording-${recording.recordingId}.vtt` });
        }
      }
    }

    // A plain-text transcript alongside the VTT: one is for a player, the other
    // is for a person with a text editor and no player.
    const plainTranscript = comments
      .filter((comment) => comment.transcript)
      .map((comment) => `[${formatOffset(comment.atOffsetMs)}] ${userNames.get(comment.userId) || comment.userId}: ${comment.transcript}`)
      .join("\n");
    if (plainTranscript) zip.append(plainTranscript, { name: "transcript/voice-notes.txt" });

    for (const comment of comments) {
      if (comment.kind !== "voice" || !comment.audioPath) continue;
      try {
        const stream = await openAsset(comment.audioPath, comment.audioPublicId);
        if (stream) zip.append(stream, { name: `voice-notes/comment-${comment.commentId}.ogg` });
      } catch (error) {
        console.warn(`[meetingArchive] voice note ${comment.commentId} skipped:`, error.message);
      }
    }

    zip.append(
      JSON.stringify(
        buildMetadata({
          session,
          event: session.event,
          agendaItems,
          notes,
          comments,
          attendees,
          recordings,
          speakingIntervals,
          userNames,
        }),
        null,
        2
      ),
      { name: "metadata.json" }
    );

    await zip.finalize();
    await finished;

    const info = await stat(bundlePath);

    let archivePath = bundlePath;
    let archivePublicId = null;

    if (isCloudinaryConfigured()) {
      const uploaded = await uploadArchiveFile(bundlePath);
      archivePath = uploaded.url;
      archivePublicId = uploaded.publicId;
    }

    const updated = await prisma.meetingSessions.update({
      where: { sessionId: id },
      data: {
        archiveStatus: ARCHIVE_STATUS.READY,
        archivePath: archivePath.slice(0, 512),
        archivePublicId,
        archiveByteSize: BigInt(info.size),
        archiveBuiltAt: new Date(),
        // Deliberately NOT setting archiveConfirmedAt.  A person has to open
        // the bundle and say it is intact before any audio may be deleted.
      },
    });

    return { session: updated, bytes: info.size, path: archivePath };
  } catch (error) {
    await prisma.meetingSessions.update({
      where: { sessionId: id },
      data: { archiveStatus: ARCHIVE_STATUS.FAILED },
    });
    throw error;
  } finally {
    // The local zip is kept when there is nowhere to upload it to — otherwise
    // the archive would be deleted the moment it was built.
    if (isCloudinaryConfigured()) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Sessions the organiser has asked for a bundle of. */
export async function pendingArchiveRequests(limit = 3) {
  return prisma.meetingSessions.findMany({
    where: { archiveStatus: ARCHIVE_STATUS.REQUESTED },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
}
