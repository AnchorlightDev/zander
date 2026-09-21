import { describe, it, expect } from "vitest";
import {
  coverageGaps,
  locateOffset,
  normaliseRecordings,
  planAgendaAdvance,
  recordedCoverageMs,
  recordedSpanMs,
  toSessionOffset,
} from "../../lib/meetings/timeline.mjs";

/**
 * A meeting session routinely holds more than one recording — the bot dropped
 * and rejoined, or a screen capture was uploaded separately — and each sits at
 * its own `startOffsetMs` on one shared timeline.
 *
 * The rule the whole module rests on: an offset is milliseconds from
 * `meetingSessions.startedAt`, never from the start of an audio file.  These
 * tests pin the arithmetic that keeps an agenda stamp, a comment and a note all
 * meaning the same moment whichever file happens to be playing.
 */

/** Bot ran 0–30 min, dropped for 5, came back 35–90 min. */
const RECONNECTED = [
  { recordingId: 1, startOffsetMs: 0, durationMs: 1_800_000, source: "discord_bot" },
  { recordingId: 2, startOffsetMs: 2_100_000, durationMs: 3_300_000, source: "discord_bot" },
];

describe("normalisation", () => {
  it("coerces Prisma BigInt columns to numbers", () => {
    // BIGINT comes back as BigInt, and mixing it with Number throws — so it is
    // coerced once here rather than at every comparison downstream.
    const [row] = normaliseRecordings([
      { recordingId: 1, startOffsetMs: 1_000n, durationMs: 2_000n },
    ]);

    expect(row.startOffsetMs).toBe(1000);
    expect(row.durationMs).toBe(2000);
    expect(row.endOffsetMs).toBe(3000);
  });

  it("orders by position on the timeline, not by insertion", () => {
    const rows = normaliseRecordings([
      { recordingId: 9, startOffsetMs: 600_000, durationMs: 1000 },
      { recordingId: 2, startOffsetMs: 0, durationMs: 1000 },
    ]);

    expect(rows.map((row) => row.recordingId)).toEqual([2, 9]);
  });
});

describe("span and coverage", () => {
  it("spans from the meeting start to the end of the last recording", () => {
    expect(recordedSpanMs(RECONNECTED)).toBe(5_400_000);
  });

  it("counts coverage without the gap", () => {
    // 30 min + 55 min of audio across a 90 minute span.
    expect(recordedCoverageMs(RECONNECTED)).toBe(1_800_000 + 3_300_000);
  });

  it("counts overlapping recordings once", () => {
    // A reconnect that double-captured ten seconds should not report more audio
    // than the meeting was long.
    const overlapping = [
      { recordingId: 1, startOffsetMs: 0, durationMs: 60_000 },
      { recordingId: 2, startOffsetMs: 50_000, durationMs: 60_000 },
    ];
    expect(recordedCoverageMs(overlapping)).toBe(110_000);
    expect(recordedSpanMs(overlapping)).toBe(110_000);
  });

  it("reports the gap the disconnect left", () => {
    expect(coverageGaps(RECONNECTED)).toEqual([
      { startOffsetMs: 1_800_000, endOffsetMs: 2_100_000 },
    ]);
  });

  it("reports a trailing gap when the meeting outlived the recording", () => {
    // The bot was kicked at 90 minutes; the meeting ran to 100.  That is real
    // information — the player says so rather than leaving a viewer who scrubs
    // there thinking the recording is broken.
    expect(coverageGaps(RECONNECTED, 6_000_000)).toEqual([
      { startOffsetMs: 1_800_000, endOffsetMs: 2_100_000 },
      { startOffsetMs: 5_400_000, endOffsetMs: 6_000_000 },
    ]);
  });

  it("reports a leading gap when recording started late", () => {
    const late = [{ recordingId: 1, startOffsetMs: 120_000, durationMs: 600_000 }];
    expect(coverageGaps(late)).toEqual([{ startOffsetMs: 0, endOffsetMs: 120_000 }]);
  });

  it("copes with a session that has no audio at all", () => {
    expect(recordedSpanMs([])).toBe(0);
    expect(recordedCoverageMs([])).toBe(0);
    expect(coverageGaps([], 60_000)).toEqual([{ startOffsetMs: 0, endOffsetMs: 60_000 }]);
  });
});

describe("locating a session offset in a file", () => {
  it("finds the first recording at the very start", () => {
    expect(locateOffset(RECONNECTED, 0)).toEqual({
      recordingId: 1,
      withinMs: 0,
      nextRecordingId: null,
    });
  });

  it("converts a session offset to a position inside the second file", () => {
    // 40 minutes into the MEETING is 5 minutes into the SECOND recording.  A
    // player that treated the offset as a file position would be 35 minutes out.
    expect(locateOffset(RECONNECTED, 2_400_000)).toEqual({
      recordingId: 2,
      withinMs: 300_000,
      nextRecordingId: null,
    });
  });

  it("excludes the exact end of a recording, so a boundary is not double-owned", () => {
    expect(locateOffset(RECONNECTED, 1_799_999).recordingId).toBe(1);
    expect(locateOffset(RECONNECTED, 1_800_000).recordingId).toBeNull();
  });

  it("points at the next recording when the offset lands in a gap", () => {
    // Clicking an agenda item the chair stamped while the bot was disconnected
    // jumps forward to the next audio there is, rather than doing nothing.
    expect(locateOffset(RECONNECTED, 1_900_000)).toEqual({
      recordingId: null,
      withinMs: 0,
      nextRecordingId: 2,
    });
  });

  it("returns nothing beyond the end of the last recording", () => {
    expect(locateOffset(RECONNECTED, 9_000_000)).toEqual({
      recordingId: null,
      withinMs: 0,
      nextRecordingId: null,
    });
  });

  it("ignores a zero-length recording", () => {
    // A stop that captured nothing files a row; it must not swallow seeks.
    const withEmpty = [{ recordingId: 3, startOffsetMs: 0, durationMs: 0 }, ...RECONNECTED];
    expect(locateOffset(withEmpty, 0).recordingId).toBe(1);
  });

  it("round-trips back to the session timeline", () => {
    const located = locateOffset(RECONNECTED, 2_400_000);
    const recording = RECONNECTED.find((row) => row.recordingId === located.recordingId);
    expect(toSessionOffset(recording, located.withinMs)).toBe(2_400_000);
  });
});

describe("agenda advance", () => {
  const agenda = [
    { itemId: 10, orderIndex: 0, startOffsetMs: null, endOffsetMs: null },
    { itemId: 11, orderIndex: 1, startOffsetMs: null, endOffsetMs: null },
    { itemId: 12, orderIndex: 2, startOffsetMs: null, endOffsetMs: null },
  ];

  it("stamps the first item and closes nothing", () => {
    const plan = planAgendaAdvance(agenda, 0);
    expect(plan.close).toBeNull();
    expect(plan.start).toEqual({ itemId: 10, startOffsetMs: 0 });
  });

  it("closes the open item and starts the next", () => {
    const running = [
      { ...agenda[0], startOffsetMs: 0 },
      agenda[1],
      agenda[2],
    ];
    const plan = planAgendaAdvance(running, 600_000);

    expect(plan.close).toEqual({ itemId: 10, endOffsetMs: 600_000, status: "discussed" });
    expect(plan.start).toEqual({ itemId: 11, startOffsetMs: 600_000 });
  });

  it("never lets a chapter end before it started", () => {
    // A double-tap on /meeting next, or a clock that went backwards, must not
    // produce a negative-length chapter.
    const running = [{ ...agenda[0], startOffsetMs: 600_000 }, agenda[1], agenda[2]];
    const plan = planAgendaAdvance(running, 599_000);

    expect(plan.close.endOffsetMs).toBe(600_000);
  });

  it("closes the last item and starts nothing when the agenda runs out", () => {
    const finished = [
      { ...agenda[0], startOffsetMs: 0, endOffsetMs: 100 },
      { ...agenda[1], startOffsetMs: 100, endOffsetMs: 200 },
      { ...agenda[2], startOffsetMs: 200 },
    ];
    const plan = planAgendaAdvance(finished, 900_000);

    expect(plan.close).toEqual({ itemId: 12, endOffsetMs: 900_000, status: "discussed" });
    expect(plan.start).toBeNull();
  });

  it("leaves a skipped item unstamped so it reads as not discussed", () => {
    // Item 11 was jumped over by hand; advancing must not silently give it a
    // start time it never had.  A null startOffsetMs is real information.
    const skipped = [
      { ...agenda[0], startOffsetMs: 0, endOffsetMs: 100 },
      { ...agenda[1], startOffsetMs: null, endOffsetMs: null },
      { ...agenda[2], startOffsetMs: 200 },
    ];
    const plan = planAgendaAdvance(skipped, 900_000);

    expect(plan.close.itemId).toBe(12);
    // The next unstarted item is 11, which is what the chair would expect to
    // return to — the plan never invents a stamp for something already passed.
    expect(plan.start).toEqual({ itemId: 11, startOffsetMs: 900_000 });
  });

  it("follows orderIndex rather than row order", () => {
    const shuffled = [
      { itemId: 12, orderIndex: 2, startOffsetMs: null, endOffsetMs: null },
      { itemId: 10, orderIndex: 0, startOffsetMs: null, endOffsetMs: null },
      { itemId: 11, orderIndex: 1, startOffsetMs: null, endOffsetMs: null },
    ];
    expect(planAgendaAdvance(shuffled, 0).start.itemId).toBe(10);
  });

  it("does nothing useful on an empty agenda without throwing", () => {
    expect(planAgendaAdvance([], 1000)).toEqual({ close: null, start: null });
  });
});
