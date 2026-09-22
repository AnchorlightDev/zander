/**
 * tests/unit/discordActivityBuffer.test.mjs
 *
 * The in-memory accumulator behind the Discord activity rollup. Imports
 * nothing and takes its writer and clock as arguments, so no database or
 * Discord client is involved here.
 */

import { describe, expect, it, vi } from "vitest";
import { createActivityBuffer } from "../../lib/discordActivityBuffer.mjs";

const dateKey = (date) => date.toISOString().slice(0, 10);

const make = (write, over = {}) =>
  createActivityBuffer({ write, dateKey, maxPending: 1000, ...over });

describe("createActivityBuffer", () => {
  it("merges repeated messages from one user on one day into a single count", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const buffer = make(write);
    const day = new Date("2026-09-22T10:00:00.000Z");

    buffer.record("111", day);
    buffer.record("111", day);
    buffer.record("111", new Date("2026-09-22T23:00:00.000Z"));

    expect(buffer.size).toBe(1);
    await buffer.flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect([...write.mock.calls[0][0]]).toEqual([["111|2026-09-22", 3]]);
  });

  it("keeps separate rows per user and per day", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const buffer = make(write);

    buffer.record("111", new Date("2026-09-22T10:00:00.000Z"));
    buffer.record("222", new Date("2026-09-22T10:00:00.000Z"));
    buffer.record("111", new Date("2026-09-23T10:00:00.000Z"));

    expect(buffer.size).toBe(3);
    await buffer.flush();

    expect([...write.mock.calls[0][0]].sort()).toEqual([
      ["111|2026-09-22", 1],
      ["111|2026-09-23", 1],
      ["222|2026-09-22", 1],
    ]);
  });

  it("ignores a blank user id", () => {
    const buffer = make(vi.fn());
    buffer.record("", new Date());
    buffer.record(null, new Date());
    expect(buffer.size).toBe(0);
  });

  it("does not write when there is nothing buffered", async () => {
    const write = vi.fn();
    expect(await make(write).flush()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("empties the buffer once a flush succeeds", async () => {
    const buffer = make(vi.fn().mockResolvedValue(undefined));
    buffer.record("111", new Date("2026-09-22T10:00:00.000Z"));

    await buffer.flush();
    expect(buffer.size).toBe(0);
  });

  it("puts the counts back when the write fails, so the next flush retries them", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const buffer = make(write);
    const day = new Date("2026-09-22T10:00:00.000Z");

    buffer.record("111", day);
    buffer.record("111", day);

    await expect(buffer.flush()).rejects.toThrow("db down");
    expect(buffer.size).toBe(1);

    buffer.record("111", day);
    await buffer.flush();

    // Two from the failed batch plus the one that arrived after it -- nothing
    // lost and nothing double-counted.
    expect([...write.mock.calls[1][0]]).toEqual([["111|2026-09-22", 3]]);
  });

  it("counts messages that arrive mid-flush into the next batch, not this one", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const write = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    const buffer = make(write);
    const day = new Date("2026-09-22T10:00:00.000Z");

    buffer.record("111", day);
    const inFlight = buffer.flush();

    buffer.record("111", day);
    release();
    await inFlight;

    expect([...write.mock.calls[0][0]]).toEqual([["111|2026-09-22", 1]]);
    expect(buffer.size).toBe(1);

    await buffer.flush();
    expect([...write.mock.calls[1][0]]).toEqual([["111|2026-09-22", 1]]);
  });

  it("flushes early once maxPending distinct rows are waiting", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const buffer = make(write, { maxPending: 3 });
    const day = new Date("2026-09-22T10:00:00.000Z");

    buffer.record("1", day);
    buffer.record("2", day);
    expect(write).not.toHaveBeenCalled();

    buffer.record("3", day);
    await buffer.flush();

    expect(write).toHaveBeenCalled();
    expect([...write.mock.calls[0][0]]).toHaveLength(3);
  });
});
