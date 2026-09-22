import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { ZERO_CHUNK, writeSilence } from "../../lib/meetings/silence.mjs";
import { bytesForOffset } from "../../lib/meetings/timeline.mjs";

/**
 * The gaps between bursts of speech are written by hand, and they are big:
 * 192 bytes per millisecond means a five minute pause is 57 MB and a long
 * disconnect is several hundred.  Node's `write()` returns false when its
 * buffer is full; a loop that ignores that queues the whole gap in memory on a
 * process that also serves every HTTP request under a 512 MB heap.
 *
 * These tests pin the two things that have to hold: every byte still gets
 * written, in order, and the writer actually stops to wait when told to.
 */

/**
 * A Writable stub that reports "full" after `highWaterMark` bytes and only
 * drains when the test says so — which is what lets these assertions be exact
 * instead of timing-dependent.
 */
class StubStream extends EventEmitter {
  constructor({ highWaterMark = 64 * 1024 } = {}) {
    super();
    this.highWaterMark = highWaterMark;
    this.written = 0;
    this.chunks = 0;
    this.pending = 0;
    this.backpressureEvents = 0;
    this.maxQueued = 0;
  }

  write(chunk) {
    this.written += chunk.length;
    this.chunks += 1;
    this.pending += chunk.length;
    this.maxQueued = Math.max(this.maxQueued, this.pending);

    if (this.pending >= this.highWaterMark) {
      this.backpressureEvents += 1;
      // Drain on the next tick, the way a real stream flushing to disk does.
      setImmediate(() => {
        this.pending = 0;
        this.emit("drain");
      });
      return false;
    }

    return true;
  }
}

describe("writeSilence", () => {
  it("writes nothing for a zero or negative length", async () => {
    const stream = new StubStream();
    expect(await writeSilence(stream, 0)).toBe(0);
    expect(await writeSilence(stream, -500)).toBe(0);
    expect(stream.written).toBe(0);
  });

  it("writes exactly the requested number of bytes", async () => {
    const stream = new StubStream();
    const bytes = bytesForOffset(5_000);

    expect(await writeSilence(stream, bytes)).toBe(bytes);
    expect(stream.written).toBe(bytes);
  });

  it("writes only zeroes", async () => {
    const stream = new StubStream();
    const seen = [];
    stream.write = (chunk) => {
      seen.push(chunk);
      return true;
    };

    await writeSilence(stream, 100_000);

    for (const chunk of seen) {
      expect(chunk.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("handles a length that is not a whole number of chunks", async () => {
    const stream = new StubStream();
    const bytes = ZERO_CHUNK.length * 2 + 17;

    await writeSilence(stream, bytes);

    expect(stream.written).toBe(bytes);
  });

  /**
   * The point of the exercise.  Five minutes of silence is 57 MB; without
   * backpressure all of it sits in the stream's queue at once.
   */
  it("never lets more than one chunk queue up", async () => {
    const stream = new StubStream({ highWaterMark: ZERO_CHUNK.length });
    const fiveMinutes = bytesForOffset(300_000);

    await writeSilence(stream, fiveMinutes);

    expect(stream.written).toBe(fiveMinutes);
    expect(stream.maxQueued).toBeLessThanOrEqual(ZERO_CHUNK.length);
    // It really did have to wait, repeatedly — otherwise this test would pass
    // against a writer that ignored backpressure entirely.
    expect(stream.backpressureEvents).toBeGreaterThan(800);
  });

  it("resolves rather than hanging when the stream errors mid-write", async () => {
    // A stream that goes bad must not leave the recording's stop path awaiting
    // a 'drain' that will never come.
    const stream = new StubStream({ highWaterMark: ZERO_CHUNK.length });
    stream.write = (chunk) => {
      stream.written += chunk.length;
      setImmediate(() => stream.emit("error", new Error("disk full")));
      return false;
    };

    await expect(writeSilence(stream, ZERO_CHUNK.length * 3)).resolves.toBe(ZERO_CHUNK.length * 3);
  });

  it("resolves when the stream closes mid-write", async () => {
    const stream = new StubStream({ highWaterMark: ZERO_CHUNK.length });
    stream.write = (chunk) => {
      stream.written += chunk.length;
      setImmediate(() => stream.emit("close"));
      return false;
    };

    await expect(writeSilence(stream, ZERO_CHUNK.length * 2)).resolves.toBe(ZERO_CHUNK.length * 2);
  });

  it("leaves no listeners behind after a long wait", async () => {
    // One listener leaked per drain would be thousands over a meeting, and
    // Node would start warning about a leak long before the meeting ended.
    const stream = new StubStream({ highWaterMark: ZERO_CHUNK.length });

    await writeSilence(stream, bytesForOffset(10_000));

    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  });

  it("preserves order against a following write", async () => {
    // The recorder awaits this before piping audio in, so the silence has to be
    // fully handed over first — otherwise a burst lands ahead of its own gap.
    const stream = new StubStream({ highWaterMark: ZERO_CHUNK.length });
    const order = [];
    const realWrite = stream.write.bind(stream);
    stream.write = (chunk) => {
      order.push(chunk.every((byte) => byte === 0) ? "silence" : "audio");
      return realWrite(chunk);
    };

    await writeSilence(stream, bytesForOffset(2_000));
    stream.write(Buffer.from([1, 2, 3, 4]));

    expect(order[order.length - 1]).toBe("audio");
    expect(order.slice(0, -1).every((entry) => entry === "silence")).toBe(true);
  });
});
