/**
 * lib/meetings/silence.mjs
 *
 * Writing silence into a per-speaker PCM track, under backpressure.
 *
 * Split out of the recorder so it can be tested against a stub stream: it takes
 * the stream rather than opening one, and imports nothing.
 *
 * Why it is not a one-liner.  A Discord receive stream only emits while someone
 * is speaking, so the gaps have to be written by hand (see
 * lib/meetings/timeline.mjs for how much).  Those gaps are large — 192 bytes per
 * millisecond means a five minute pause is 57 MB, and a long disconnect is
 * several hundred.  `stream.write()` returns false when the stream's buffer is
 * full; looping past that queues the entire gap in memory, on a process that
 * also serves every HTTP request under --max-old-space-size=512.  Waiting for
 * 'drain' holds it to one buffer's worth however long the gap is.
 */

/**
 * One reusable block of zeroes.
 *
 * Shared and never mutated, so it is safe to hand the same buffer to `write()`
 * repeatedly even though a backed-up stream keeps it by reference rather than
 * copying it.
 */
export const ZERO_CHUNK = Buffer.alloc(64 * 1024);

/**
 * Write `byteCount` zero bytes to `stream`, respecting backpressure.
 *
 * Resolves once every byte has been handed to the stream — in order, so a
 * caller that awaits this before piping audio in is guaranteed the silence
 * lands first.
 *
 * @param {import("stream").Writable} stream
 * @param {number} byteCount
 * @returns {Promise<number>} bytes written
 */
export async function writeSilence(stream, byteCount) {
  const total = Math.max(0, Math.floor(Number(byteCount) || 0));
  if (total === 0) return 0;

  let remaining = total;

  while (remaining > 0) {
    const size = Math.min(remaining, ZERO_CHUNK.length);
    const chunk = size === ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, size);
    remaining -= size;

    if (!stream.write(chunk)) {
      // 'drain' is the only thing awaited here.  A stream that errors instead
      // would otherwise leave this hanging forever, taking the recording's
      // stop path with it, so an error resolves the wait and lets the caller's
      // own error handling deal with it.
      await new Promise((resolve) => {
        const done = () => {
          stream.removeListener("drain", done);
          stream.removeListener("error", done);
          stream.removeListener("close", done);
          resolve();
        };
        stream.once("drain", done);
        stream.once("error", done);
        stream.once("close", done);
      });
    }
  }

  return total;
}
