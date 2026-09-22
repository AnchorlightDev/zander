/**
 * lib/discordActivityBuffer.mjs
 *
 * In-memory accumulator for Discord message counts.
 *
 * A database write per message is far too much on a busy guild -- a lively
 * evening is thousands of messages, and every one of them would be an UPDATE on
 * the same handful of rows. Instead counts pile up here keyed by user and date,
 * and get flushed as one statement periodically.
 *
 * Imports nothing and takes its writer and its clock as arguments, so the
 * batching can be tested without a database, a timer or a Discord client.
 *
 * Flushing is lossy on a hard kill: up to one interval's worth of counts can be
 * lost if the process dies between flushes. That is the accepted trade for the
 * write volume -- this data drives a "were you around regularly?" threshold, not
 * anything that has to balance.
 */

/**
 * @param {object} options
 * @param {(counts: Map<string, number>) => Promise<unknown>} options.write
 *   Persists a batch. Called with a Map keyed "<discordUserId>|<YYYY-MM-DD>".
 * @param {(date: Date) => string} options.dateKey  Local-date key builder.
 * @param {number} [options.flushIntervalMs]  How often to flush. Default 30s.
 * @param {number} [options.maxPending]
 *   Flush early once this many distinct user/date pairs are waiting, so a burst
 *   does not sit in memory for the whole interval.
 */
export function createActivityBuffer({
  write,
  dateKey,
  flushIntervalMs = 30_000,
  maxPending = 500,
}) {
  let pending = new Map();
  let timer = null;
  let flushing = null;

  /** Count one message. Returns the buffer's new size. */
  function record(discordUserId, when = new Date()) {
    const id = String(discordUserId || "").trim();
    if (!id) return pending.size;

    const key = `${id}|${dateKey(when)}`;
    pending.set(key, (pending.get(key) || 0) + 1);

    if (pending.size >= maxPending) {
      // Fire and forget: the caller is a message handler and must not wait.
      flush().catch(() => {});
    }

    return pending.size;
  }

  /**
   * Write everything buffered so far.
   *
   * The map is swapped out before the await, so messages arriving mid-flush
   * accumulate into the next batch rather than being counted twice or lost.
   * Overlapping calls share the in-flight promise.
   */
  async function flush() {
    if (flushing) return flushing;
    if (pending.size === 0) return 0;

    const batch = pending;
    pending = new Map();

    flushing = (async () => {
      try {
        await write(batch);
        return batch.size;
      } catch (error) {
        // Put the counts back so the next flush retries them, merging with
        // anything that arrived in the meantime.
        for (const [key, count] of batch) {
          pending.set(key, (pending.get(key) || 0) + count);
        }
        throw error;
      } finally {
        flushing = null;
      }
    })();

    return flushing;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      flush().catch((error) => {
        console.error("[discordActivity] Flush failed:", error.message);
      });
    }, flushIntervalMs);
    // Never hold the process open for a counter.
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { record, flush, start, stop, get size() { return pending.size; } };
}
