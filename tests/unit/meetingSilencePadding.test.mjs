import { describe, it, expect } from "vitest";
import {
  PCM_BYTES_PER_FRAME,
  PCM_BYTES_PER_MS,
  bytesForOffset,
  offsetForBytes,
  paddingBytesFor,
  tailPaddingBytesFor,
} from "../../lib/meetings/timeline.mjs";

/**
 * The meeting recorder writes one PCM file per speaker, but a Discord receive
 * stream only emits while that person is actually talking.  Naive concatenation
 * therefore deletes every pause: a 60 minute meeting with 12 minutes of speech
 * becomes 12 minutes of audio, every speaker drifts away from every other
 * speaker, and all of it drifts away from the agenda stamps.
 *
 * The fix is to pad silence to an ABSOLUTE byte offset before every burst,
 * computed from wall-clock elapsed against the session's startedAt.  These
 * tests exist because that bug is silent — the audio still plays, it just stops
 * lining up a few minutes in, and by then the meeting is over.
 */
describe("PCM geometry", () => {
  it("is 192 bytes per millisecond at 48kHz stereo s16le", () => {
    // 48000 samples/s x 2 channels x 2 bytes = 192000 bytes/s.
    expect(PCM_BYTES_PER_MS).toBe(192);
  });

  it("puts every millisecond boundary on a frame boundary", () => {
    // If this were not true, padding could leave one channel half a sample out
    // of phase with the other for the rest of the file.
    expect(PCM_BYTES_PER_MS % PCM_BYTES_PER_FRAME).toBe(0);
  });

  it("round-trips offsets through byte positions", () => {
    for (const ms of [0, 1, 999, 1000, 60_000, 5_400_000]) {
      expect(offsetForBytes(bytesForOffset(ms))).toBe(ms);
    }
  });
});

describe("absolute silence padding", () => {
  it("pads an empty track out to the burst's start", () => {
    expect(paddingBytesFor(0, 1000)).toBe(192_000);
  });

  it("pads nothing when the track is already at the burst", () => {
    expect(paddingBytesFor(192_000, 1000)).toBe(0);
  });

  it("never returns a negative padding when the track has overrun", () => {
    // A burst can only be appended, so a track that is slightly long is left
    // long rather than having audio rewritten.
    expect(paddingBytesFor(300_000, 1000)).toBe(0);
  });

  /**
   * The property that matters: after N bursts, the track's length is decided by
   * the LAST burst's offset alone.  Nothing earlier can push it out of place.
   */
  it("holds absolute position across a long meeting", () => {
    let written = 0;

    // A burst every ~7 seconds for an hour, each 1.5s of speech.
    for (let offsetMs = 0; offsetMs < 3_600_000; offsetMs += 7_000) {
      written += paddingBytesFor(written, offsetMs);
      expect(written).toBe(bytesForOffset(offsetMs));
      written += 1500 * PCM_BYTES_PER_MS;
    }
  });

  it("self-corrects when a burst is dropped entirely", () => {
    let written = 0;

    // Burst one lands.
    written += paddingBytesFor(written, 1_000);
    written += 500 * PCM_BYTES_PER_MS;

    // Burst two is dropped — a decode error, a receive stream that errored.
    // Nothing is written for it at all.

    // Burst three pads from where it should be, not from where burst two left
    // off, so the gap the dropped burst left is filled with silence.
    written += paddingBytesFor(written, 10_000);

    expect(written).toBe(bytesForOffset(10_000));
  });

  it("self-corrects when a burst is written short", () => {
    let written = 0;

    written += paddingBytesFor(written, 1_000);
    // Claimed 2000ms of speech, only 1200ms of frames actually arrived.
    written += 1200 * PCM_BYTES_PER_MS;

    written += paddingBytesFor(written, 3_000);

    expect(written).toBe(bytesForOffset(3_000));
  });

  /**
   * The regression this whole design exists to prevent.  An incremental scheme
   * — pad by (elapsed - lastElapsed) — looks identical on a clean run and
   * accumulates every dropped or short burst on a real one.
   */
  it("does not drift the way an incremental scheme does", () => {
    const bursts = [];
    for (let offsetMs = 0; offsetMs < 600_000; offsetMs += 5_000) {
      bursts.push({ offsetMs, speechMs: 800 });
    }
    // One burst in ten never arrives.
    const arriving = bursts.filter((_, index) => index % 10 !== 3);

    let absolute = 0;
    for (const burst of arriving) {
      absolute += paddingBytesFor(absolute, burst.offsetMs);
      absolute += burst.speechMs * PCM_BYTES_PER_MS;
    }

    // The incremental scheme as it is naturally written: measure the gap since
    // the previous burst was seen, write that much silence, then append the
    // speech.  It looks right, and it double-counts every burst's own speech.
    let incremental = 0;
    let lastSeenMs = 0;
    for (const burst of arriving) {
      incremental += (burst.offsetMs - lastSeenMs) * PCM_BYTES_PER_MS;
      incremental += burst.speechMs * PCM_BYTES_PER_MS;
      lastSeenMs = burst.offsetMs;
    }

    const last = arriving[arriving.length - 1];
    expect(offsetForBytes(absolute)).toBe(last.offsetMs + last.speechMs);

    // The incremental version has silently gained more than a minute of length
    // over a ten minute meeting — by the end, the audio and the agenda stamps
    // are describing different moments.
    const drift = offsetForBytes(incremental) - (last.offsetMs + last.speechMs);
    expect(drift).toBeGreaterThan(60_000);
  });

  it("pauses cost the timeline nothing", () => {
    let written = 0;

    written += paddingBytesFor(written, 1_000);
    written += 2_000 * PCM_BYTES_PER_MS;

    // Five minutes of /meeting pause: no subscriptions, nothing written.

    written += paddingBytesFor(written, 303_000);

    // The gap is silence of exactly the right length, with no bookkeeping of
    // the pause needed anywhere.
    expect(offsetForBytes(written)).toBe(303_000);
  });
});

describe("tail padding at stop", () => {
  it("brings every track to the same length", () => {
    // Three speakers who stopped talking at different points; at stop time they
    // are all padded to the meeting's full length so the mix does not end
    // raggedly and no track is short.
    const tracks = [
      { written: bytesForOffset(1_200_000) },
      { written: bytesForOffset(3_400_000) },
      { written: bytesForOffset(90_000) },
    ];
    const durationMs = 3_600_000;

    const padded = tracks.map((track) => track.written + tailPaddingBytesFor(track.written, durationMs));

    for (const length of padded) expect(offsetForBytes(length)).toBe(durationMs);
    expect(new Set(padded).size).toBe(1);
  });
});
