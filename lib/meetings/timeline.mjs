/**
 * lib/meetings/timeline.mjs
 *
 * Pure timeline maths for the meeting recorder and player.  No database and no
 * filesystem imports, so the padding and offset rules are unit-testable on
 * their own — which matters more here than anywhere else in the module,
 * because a drift bug is silent: the audio still plays, it just stops lining up
 * with the agenda stamps a few minutes in.
 *
 * ANCHOR RULE: every offset in this file is milliseconds from
 * `meetingSessions`.`startedAt`.  Never from the start of an audio file.
 */

/** 48 kHz, 2 channels, signed 16-bit LE — what prism-media decodes Opus into. */
export const PCM_SAMPLE_RATE = 48000;
export const PCM_CHANNELS = 2;
export const PCM_BYTES_PER_SAMPLE = 2;

/** One stereo frame: both channels, 16 bits each. */
export const PCM_BYTES_PER_FRAME = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;

/**
 * 192 bytes of PCM per millisecond.  Conveniently a whole number *and* a
 * multiple of the frame size, so a millisecond boundary is always also a frame
 * boundary and padding can never leave a track half a sample out of phase.
 */
export const PCM_BYTES_PER_MS =
  (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE) / 1000;

/** Raw PCM cost, for the comment explaining why scratch files are deleted. */
export const PCM_BYTES_PER_MINUTE = PCM_BYTES_PER_MS * 60_000;

/**
 * Byte position in a per-speaker PCM track corresponding to a session offset.
 *
 * Rounded down to a whole frame: a partial frame would shift one channel
 * relative to the other for the remainder of the file.
 */
export function bytesForOffset(offsetMs) {
  const ms = Math.max(0, Math.floor(Number(offsetMs) || 0));
  const bytes = ms * PCM_BYTES_PER_MS;
  return bytes - (bytes % PCM_BYTES_PER_FRAME);
}

/** Inverse of bytesForOffset, for reporting a track's current length. */
export function offsetForBytes(byteCount) {
  const bytes = Math.max(0, Number(byteCount) || 0);
  return Math.floor(bytes / PCM_BYTES_PER_MS);
}

/**
 * How much silence to write before a burst of speech, so the burst lands at
 * `offsetMs` on the session timeline.
 *
 * Deliberately computed from the *absolute* target position against the bytes
 * already written, not as a delta since the previous burst.  A Discord receive
 * stream only emits while someone is actually speaking, so naive concatenation
 * removes every silence — a two-minute meeting with thirty seconds of talking
 * becomes thirty seconds of audio, and every speaker desynchronises from every
 * other speaker and from the agenda stamps.
 *
 * Absolute padding is self-correcting: a burst that was dropped, arrived late,
 * or was written short is absorbed by the next call, because the next call only
 * ever asks "how far short of where I should be am I?".  An incremental
 * `elapsed - lastElapsed` scheme accumulates every one of those errors instead.
 *
 * Returns 0 rather than a negative number when the track is already at or past
 * the target — a burst can only ever be appended, so the timeline is allowed to
 * run slightly long rather than have audio rewritten.
 */
export function paddingBytesFor(bytesWritten, offsetMs) {
  const target = bytesForOffset(offsetMs);
  const written = Math.max(0, Number(bytesWritten) || 0);
  return Math.max(0, target - written);
}

/**
 * Pad a track out to a given offset, as a byte count.  Same maths as
 * paddingBytesFor; named separately because the call site at stop time reads
 * very differently from the one in the speaking handler.
 */
export function tailPaddingBytesFor(bytesWritten, totalDurationMs) {
  return paddingBytesFor(bytesWritten, totalDurationMs);
}

// ============================================================================
// Multi-recording sessions
// ============================================================================

/**
 * Normalise recording rows onto the session timeline.
 *
 * Prisma hands BIGINT columns back as BigInt, and mixing those with Numbers
 * throws, so everything is coerced to Number here once rather than at every
 * comparison.  A meeting would have to run for 285,000 years to overflow
 * Number.MAX_SAFE_INTEGER in milliseconds.
 */
export function normaliseRecordings(recordings = []) {
  return (recordings || [])
    .map((recording) => {
      const startOffsetMs = Number(recording.startOffsetMs ?? 0);
      const durationMs = Number(recording.durationMs ?? 0);
      return {
        recordingId: recording.recordingId,
        source: recording.source,
        startOffsetMs,
        durationMs,
        endOffsetMs: startOffsetMs + durationMs,
        storagePath: recording.storagePath,
        storagePublicId: recording.storagePublicId ?? null,
      };
    })
    .sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.recordingId - b.recordingId);
}

/**
 * Span covered by the recordings, in session offsets.
 *
 * This is NOT the meeting length: `meetingSessions`.`durationMs` is, because a
 * meeting keeps running after the bot has been disconnected.  This is only how
 * much of it there is audio for.
 */
export function recordedSpanMs(recordings = []) {
  const rows = normaliseRecordings(recordings);
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((row) => row.endOffsetMs));
}

/**
 * Total audio actually captured, excluding the gaps between recordings.
 * Overlapping recordings (a reconnect that double-captured a few seconds) are
 * counted once.
 */
export function recordedCoverageMs(recordings = []) {
  const rows = normaliseRecordings(recordings).filter((row) => row.durationMs > 0);
  if (rows.length === 0) return 0;

  let covered = 0;
  let cursor = -Infinity;

  for (const row of rows) {
    const start = Math.max(row.startOffsetMs, cursor);
    if (row.endOffsetMs > start) {
      covered += row.endOffsetMs - start;
      cursor = row.endOffsetMs;
    }
  }

  return covered;
}

/**
 * Stretches of the meeting with no audio at all — the bot being disconnected,
 * or a meeting that started before anyone remembered to record it.  Surfaced in
 * the player so a viewer who scrubs into one is told why it is silent rather
 * than assuming the recording is broken.
 */
export function coverageGaps(recordings = [], sessionDurationMs = null) {
  const rows = normaliseRecordings(recordings).filter((row) => row.durationMs > 0);
  const total = Number(sessionDurationMs ?? 0) || recordedSpanMs(rows);

  const gaps = [];
  let cursor = 0;

  for (const row of rows) {
    if (row.startOffsetMs > cursor) {
      gaps.push({ startOffsetMs: cursor, endOffsetMs: row.startOffsetMs });
    }
    cursor = Math.max(cursor, row.endOffsetMs);
  }

  if (total > cursor) gaps.push({ startOffsetMs: cursor, endOffsetMs: total });

  return gaps;
}

/**
 * Which recording to play, and how far into it to seek, for a point on the
 * session timeline.
 *
 * Returns `{ recordingId, withinMs }` when the offset falls inside a recording.
 * When it falls in a gap, `recordingId` is null and `nextRecordingId` names the
 * recording the player should skip forward to — so clicking an agenda item that
 * was discussed while the bot was disconnected lands on the next audio there is
 * rather than doing nothing.
 */
export function locateOffset(recordings, offsetMs) {
  const rows = normaliseRecordings(recordings).filter((row) => row.durationMs > 0);
  const target = Math.max(0, Number(offsetMs) || 0);

  for (const row of rows) {
    if (target >= row.startOffsetMs && target < row.endOffsetMs) {
      return {
        recordingId: row.recordingId,
        withinMs: target - row.startOffsetMs,
        nextRecordingId: null,
      };
    }
  }

  const next = rows.find((row) => row.startOffsetMs > target) || null;

  return {
    recordingId: null,
    withinMs: 0,
    nextRecordingId: next ? next.recordingId : null,
  };
}

/**
 * The inverse: a position inside one file, expressed on the session timeline.
 * This is what turns "the viewer is 4 minutes into part two" into an offset a
 * comment can be anchored at.
 */
export function toSessionOffset(recording, withinMs) {
  const start = Number(recording?.startOffsetMs ?? 0);
  return start + Math.max(0, Number(withinMs) || 0);
}

/**
 * Close the open agenda item and stamp the next one, given the agenda in order
 * and the current offset.
 *
 * Pure so the advance rules — never re-stamp an item that already started,
 * never let an end precede its own start — are testable without a session.
 * Returns the mutations to apply, not the mutated rows.
 */
export function planAgendaAdvance(items, offsetMs) {
  const at = Math.max(0, Number(offsetMs) || 0);
  const ordered = [...(items || [])].sort(
    (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0) || a.itemId - b.itemId
  );

  // The open item is the last one that has been started but not yet ended.
  const open =
    [...ordered].reverse().find((item) => item.startOffsetMs != null && item.endOffsetMs == null) ||
    null;

  // The next item is the first that has never been started.  An item that was
  // skipped stays unstamped and reads as "not discussed".
  const next = ordered.find((item) => item.startOffsetMs == null) || null;

  return {
    close: open
      ? {
          itemId: open.itemId,
          // Never behind its own start: a clock skew or a double-tap on /meeting
          // next must not produce a negative-length chapter.
          endOffsetMs: Math.max(at, Number(open.startOffsetMs)),
          status: "discussed",
        }
      : null,
    start: next ? { itemId: next.itemId, startOffsetMs: at } : null,
  };
}
