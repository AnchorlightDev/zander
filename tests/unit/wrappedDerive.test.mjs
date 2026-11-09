import { describe, expect, it } from "vitest";
import { resolveWrappedPeriod } from "../../lib/wrapped/period.js";
import { rankOf, pctChange, humanizeDuration, vibeLabel, neighborhood } from "../../lib/wrapped/derive.js";

describe("resolveWrappedPeriod", () => {
  it("defaults to a rolling 12 months ending today", () => {
    const p = resolveWrappedPeriod(new Date("2026-08-01T12:00:00Z"));
    expect(p.start.toISOString()).toBe("2025-08-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-08-01T23:59:59.999Z");
    expect(p.year).toBe(2026);
    expect(p.active).toBe(true); // rolling window is always "active" while enabled
  });

  it("honours a custom rolling length", () => {
    const p = resolveWrappedPeriod(new Date("2026-08-15T12:00:00Z"), { rollingMonths: 3 });
    expect(p.start.toISOString()).toBe("2026-05-15T00:00:00.000Z");
    expect(p.label).toBe("Last 3 months");
  });

  it("honours an MM-DD span within the current year", () => {
    const p = resolveWrappedPeriod(new Date("2025-06-15T12:00:00Z"), {
      periodStart: "06-01",
      periodEnd: "06-30",
    });
    expect(p.start.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2025-06-30T23:59:59.999Z");
    expect(p.active).toBe(true);
  });

  it("honours exact YYYY-MM-DD bounds", () => {
    const p = resolveWrappedPeriod(new Date("2026-01-01T12:00:00Z"), {
      periodStart: "2024-09-01",
      periodEnd: "2025-09-01",
    });
    expect(p.start.toISOString()).toBe("2024-09-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2025-09-01T23:59:59.999Z");
    expect(p.year).toBe(2025);
    expect(p.active).toBe(false); // now is past the fixed end
  });

  it("respects the enabled flag", () => {
    expect(resolveWrappedPeriod(new Date(), { enabled: false }).active).toBe(false);
  });
});

describe("rankOf", () => {
  const entries = [
    { userId: 1, value: 100 },
    { userId: 2, value: 300 },
    { userId: 3, value: 200 },
  ];
  it("ranks highest value as #1", () => {
    expect(rankOf(entries, 2)).toEqual({ rank: 1, total: 3 });
    expect(rankOf(entries, 3)).toEqual({ rank: 2, total: 3 });
    expect(rankOf(entries, 1)).toEqual({ rank: 3, total: 3 });
  });
  it("returns null for unknown user or empty set", () => {
    expect(rankOf(entries, 99)).toBeNull();
    expect(rankOf([], 1)).toBeNull();
  });
});

describe("neighborhood", () => {
  const entries = [
    { userId: 1, value: 500 },
    { userId: 2, value: 400 },
    { userId: 3, value: 300 },
    { userId: 4, value: 200 },
    { userId: 5, value: 100 },
  ];
  const names = { 1: "Alex", 2: "Sam", 3: "Jamie", 4: "Chris", 5: "Pat" };

  it("slices a window around the user with 'You' substituted", () => {
    const nb = neighborhood(entries, 3, names, 1);
    expect(nb.rank).toBe(3);
    expect(nb.total).toBe(5);
    expect(nb.rows).toEqual([
      { rank: 2, name: "Sam", value: 400, avatar: null, you: false },
      { rank: 3, name: "You", value: 300, avatar: null, you: true },
      { rank: 4, name: "Chris", value: 200, avatar: null, you: false },
    ]);
  });

  it("attaches avatars from avatarById (including the 'You' row)", () => {
    const avatars = { 2: "https://cdn/av/sam.png", 3: "https://cdn/av/me.png", 4: "https://cdn/av/chris.png" };
    const nb = neighborhood(entries, 3, names, 1, avatars);
    expect(nb.rows.map((r) => r.avatar)).toEqual([
      "https://cdn/av/sam.png",
      "https://cdn/av/me.png",
      "https://cdn/av/chris.png",
    ]);
    // missing avatar -> null, never undefined
    expect(neighborhood(entries, 3, names, 1, { 3: "x" }).rows[0].avatar).toBeNull();
  });

  it("clamps the window at the top and bottom of the board", () => {
    expect(neighborhood(entries, 1, names, 2).rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(neighborhood(entries, 5, names, 2).rows.map((r) => r.rank)).toEqual([3, 4, 5]);
  });

  it("accepts a Map for names and falls back to 'Someone'", () => {
    const nb = neighborhood(entries, 2, new Map([[1, "Alex"]]), 1);
    expect(nb.rows.map((r) => r.name)).toEqual(["Alex", "You", "Someone"]);
  });

  it("returns null for an unknown user or empty set", () => {
    expect(neighborhood(entries, 99, names)).toBeNull();
    expect(neighborhood([], 1, names)).toBeNull();
  });

  it("ranks a numeric user against a mix of numeric, 'd:' and 'u:' rows without collision", () => {
    // The regression guard for the shop-stat key fix: unlinked buyers keyed by
    // uuid ("u:<uuid>") must each count as a distinct row, not collapse onto a
    // single "d:" bucket.
    const mixed = [
      { userId: "u:aaaa", value: 500 },
      { userId: "d:111", value: 400 },
      { userId: 7, value: 300 }, // the viewing user
      { userId: "u:bbbb", value: 200 },
      { userId: "u:cccc", value: 100 },
    ];
    const nb = neighborhood(mixed, 7, { 7: "ignored" }, 1);
    expect(nb.total).toBe(5); // no collision — five separate rows
    expect(nb.rank).toBe(3);
    expect(nb.rows.map((r) => [r.rank, r.you])).toEqual([
      [2, false],
      [3, true],
      [4, false],
    ]);
  });
});

describe("pctChange", () => {
  it("computes rounded percent change", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(75, 100)).toBe(-25);
  });
  it("returns null without a usable baseline", () => {
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
  });
});

describe("humanizeDuration", () => {
  it("formats short spans in h/m/s", () => {
    expect(humanizeDuration(0)).toBe("no time at all");
    expect(humanizeDuration(45)).toBe("45s");
    expect(humanizeDuration(90)).toBe("1m");
    expect(humanizeDuration(3660)).toBe("1h 1m");
    expect(humanizeDuration(7200)).toBe("2h");
  });
  it("rolls hours up into days and months (largest two units)", () => {
    expect(humanizeDuration(144000)).toBe("1d 16h"); // 40h
    expect(humanizeDuration(90000)).toBe("1d 1h"); // 25h
    expect(humanizeDuration(2 * 86400)).toBe("2d");
    expect(humanizeDuration(30 * 86400 + 3 * 86400 + 5 * 3600)).toBe("1mo 3d 5h");
  });
});

describe("vibeLabel", () => {
  it("labels a high-playtime, high-message player a Chatty Grinder", () => {
    const v = vibeLabel({ playtimeSeconds: 400 * 3600, discordMessages: 900, voiceMinutes: 30, sessions: 200 });
    expect(v.label).toBe("Chatty Grinder");
  });
  it("labels a light player a Weekend Visitor", () => {
    const v = vibeLabel({ playtimeSeconds: 5 * 3600, discordMessages: 10, voiceMinutes: 0, sessions: 4 });
    expect(v.label).toBe("Weekend Visitor");
  });
  it("always returns a label and blurb", () => {
    const v = vibeLabel({ playtimeSeconds: 40 * 3600, discordMessages: 100, voiceMinutes: 120, sessions: 50 });
    expect(typeof v.label).toBe("string");
    expect(typeof v.blurb).toBe("string");
  });
});
