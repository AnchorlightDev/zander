/**
 * tests/unit/formRequirements.test.mjs
 *
 * The eligibility rules and the form passcode.
 *
 * Both modules under test import nothing but node:crypto, so every case here
 * runs against fabricated measured values -- no database, no LiteBans, no
 * Discord client.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateRequirements,
  formatDuration,
  hasRequirements,
  isWithinWindow,
  normaliseRequirements,
  windowStart,
} from "../../lib/formRequirements.mjs";
import {
  hasUnlocked,
  markUnlocked,
  requiresAccessCode,
  verifyAccessCode,
} from "../../lib/formAccess.mjs";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const DAY = 86400000;

describe("normaliseRequirements", () => {
  it("returns null for anything that is not a rule set", () => {
    expect(normaliseRequirements(null)).toBeNull();
    expect(normaliseRequirements({})).toBeNull();
    expect(normaliseRequirements("nonsense")).toBeNull();
    expect(normaliseRequirements([1, 2])).toBeNull();
    expect(normaliseRequirements({ somethingElse: 4 })).toBeNull();
  });

  it("parses a blob that round-tripped through the JSON column as a string", () => {
    expect(normaliseRequirements('{"minPlaytimeHours":20}')).toEqual({ minPlaytimeHours: 20 });
  });

  it("drops zero and negative thresholds rather than enforcing them", () => {
    expect(normaliseRequirements({ minPlaytimeHours: 0 })).toBeNull();
    expect(normaliseRequirements({ minPlaytimeHours: -5 })).toBeNull();
  });

  it("clamps a threshold to its ceiling", () => {
    expect(normaliseRequirements({ noPunishmentsDays: 99999 })).toEqual({ noPunishmentsDays: 3650 });
  });

  it("fills in a default window for a rule that needs one", () => {
    expect(normaliseRequirements({ minMinecraftActiveDays: 12 })).toEqual({
      minMinecraftActiveDays: 12,
      minMinecraftActiveWindowDays: 30,
    });
  });

  it("drops a window whose rule was not set", () => {
    expect(normaliseRequirements({ minDiscordActiveWindowDays: 30 })).toBeNull();
  });

  it("pulls an unsatisfiable active-day count back to the window", () => {
    expect(
      normaliseRequirements({ minMinecraftActiveDays: 60, minMinecraftActiveWindowDays: 30 })
    ).toEqual({ minMinecraftActiveDays: 30, minMinecraftActiveWindowDays: 30 });
  });

  it("knows whether a form is gated at all", () => {
    expect(hasRequirements(null)).toBe(false);
    expect(hasRequirements({ minPlaytimeHours: 1 })).toBe(true);
  });
});

describe("window boundaries", () => {
  it("opens exactly n days before now", () => {
    expect(windowStart(90, NOW).getTime()).toBe(NOW.getTime() - 90 * DAY);
  });

  it("includes its own edge: a punishment exactly 90 days old still counts", () => {
    const exactly = new Date(NOW.getTime() - 90 * DAY);
    expect(isWithinWindow(exactly, 90, NOW)).toBe(true);
  });

  it("excludes one millisecond past the edge", () => {
    const justOutside = new Date(NOW.getTime() - 90 * DAY - 1);
    expect(isWithinWindow(justOutside, 90, NOW)).toBe(false);
  });

  it("includes something from yesterday and excludes something from last year", () => {
    expect(isWithinWindow(new Date(NOW.getTime() - DAY), 90, NOW)).toBe(true);
    expect(isWithinWindow(new Date(NOW.getTime() - 400 * DAY), 90, NOW)).toBe(false);
  });

  it("treats a missing or unparseable date as outside", () => {
    expect(isWithinWindow(null, 90, NOW)).toBe(false);
    expect(isWithinWindow("not a date", 90, NOW)).toBe(false);
  });
});

describe("formatDuration", () => {
  it("quotes hours and minutes back the way the failure message needs", () => {
    expect(formatDuration(12 * 3600 + 30 * 60)).toBe("12h 30m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(45 * 60)).toBe("45m");
    expect(formatDuration(0)).toBe("none");
    expect(formatDuration(null)).toBe("none");
  });
});

describe("evaluateRequirements", () => {
  const ungated = { ok: true, checks: [] };

  it("passes a form with no rules", () => {
    expect(evaluateRequirements(null, {}, { now: NOW })).toEqual(ungated);
    expect(evaluateRequirements({}, {}, { now: NOW })).toEqual(ungated);
  });

  describe("playtime", () => {
    const rules = { minPlaytimeHours: 20 };

    it("passes on exactly the threshold", () => {
      const result = evaluateRequirements(rules, { playtimeSeconds: 20 * 3600 }, { now: NOW });
      expect(result.ok).toBe(true);
    });

    it("fails below it and quotes both numbers", () => {
      const result = evaluateRequirements(
        rules,
        { playtimeSeconds: 12 * 3600 + 30 * 60 },
        { now: NOW }
      );
      expect(result.ok).toBe(false);
      expect(result.checks[0].message).toBe(
        "You need 20 hours of playtime; you have 12h 30m."
      );
    });

    it("fails a player who has never joined", () => {
      expect(evaluateRequirements(rules, {}, { now: NOW }).ok).toBe(false);
    });
  });

  describe("clean record", () => {
    const rules = { noPunishmentsDays: 90 };

    it("passes with nothing in the window", () => {
      const result = evaluateRequirements(rules, { punishmentCount: 0 }, { now: NOW });
      expect(result.ok).toBe(true);
      expect(result.checks[0].actual).toBe("clean");
    });

    it("fails with one and says how many", () => {
      const result = evaluateRequirements(rules, { punishmentCount: 2 }, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.checks[0].message).toMatch(/clean record for the last 90 days; you have 2 punishments/);
    });
  });

  describe("Minecraft consistency", () => {
    const rules = { minMinecraftActiveDays: 12, minMinecraftActiveWindowDays: 30 };

    it("passes on the threshold", () => {
      expect(evaluateRequirements(rules, { minecraftActiveDays: 12 }, { now: NOW }).ok).toBe(true);
    });

    it("fails below it", () => {
      const result = evaluateRequirements(rules, { minecraftActiveDays: 7 }, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.checks[0].message).toMatch(/12 separate days in the last 30; you have played on 7 days/);
    });
  });

  describe("Discord consistency", () => {
    const rules = {
      minDiscordActiveDays: 8,
      minDiscordMessages: 50,
      minDiscordActiveWindowDays: 30,
    };
    // Tracking started long before the window, so the checks really apply.
    const measured = (over) => ({
      discordLinked: true,
      discordDataFrom: new Date(NOW.getTime() - 200 * DAY),
      ...over,
    });

    it("passes when both thresholds are met", () => {
      const result = evaluateRequirements(
        rules,
        measured({ discordActiveDays: 8, discordMessages: 50 }),
        { now: NOW }
      );
      expect(result.ok).toBe(true);
    });

    it("fails on days", () => {
      const result = evaluateRequirements(
        rules,
        measured({ discordActiveDays: 3, discordMessages: 500 }),
        { now: NOW }
      );
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.key === "minDiscordActiveDays").ok).toBe(false);
      expect(result.checks.find((c) => c.key === "minDiscordMessages").ok).toBe(true);
    });

    it("fails on message count", () => {
      const result = evaluateRequirements(
        rules,
        measured({ discordActiveDays: 30, discordMessages: 4 }),
        { now: NOW }
      );
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.key === "minDiscordMessages").message).toMatch(
        /50 Discord messages in the last 30 days; you have sent 4 messages/
      );
    });

    it("tells an unlinked applicant to link, rather than reporting zero days", () => {
      const result = evaluateRequirements(rules, { discordLinked: false }, { now: NOW });
      expect(result.ok).toBe(false);
      for (const check of result.checks) {
        expect(check.skipped).toBe(false);
        expect(check.message).toMatch(/Link your Discord account/);
      }
    });

    it("skips the checks while the rollup is younger than the window", () => {
      const result = evaluateRequirements(
        rules,
        measured({ discordDataFrom: new Date(NOW.getTime() - 5 * DAY), discordActiveDays: 1, discordMessages: 1 }),
        { now: NOW }
      );
      expect(result.ok).toBe(true);
      expect(result.checks.every((c) => c.skipped)).toBe(true);
    });

    it("skips the checks when nothing has been counted at all", () => {
      const result = evaluateRequirements(
        rules,
        { discordLinked: true, discordDataFrom: null },
        { now: NOW }
      );
      expect(result.ok).toBe(true);
      expect(result.checks.every((c) => c.skipped)).toBe(true);
    });

    it("applies them anyway when the cold-start skip is turned off", () => {
      const result = evaluateRequirements(
        rules,
        measured({ discordDataFrom: new Date(NOW.getTime() - 5 * DAY), discordActiveDays: 1, discordMessages: 1 }),
        { now: NOW, skipUnmeasurableDiscord: false }
      );
      expect(result.ok).toBe(false);
    });
  });

  it("reports every check, not just the first failure", () => {
    const result = evaluateRequirements(
      { minPlaytimeHours: 20, noPunishmentsDays: 90, minMinecraftActiveDays: 12 },
      { playtimeSeconds: 0, punishmentCount: 1, minecraftActiveDays: 0 },
      { now: NOW }
    );
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.ok === false)).toBe(true);
  });

  it("passes only when every check passes", () => {
    const rules = { minPlaytimeHours: 20, noPunishmentsDays: 90, minMinecraftActiveDays: 12 };
    const measured = { playtimeSeconds: 100 * 3600, punishmentCount: 0, minecraftActiveDays: 30 };

    expect(evaluateRequirements(rules, measured, { now: NOW }).ok).toBe(true);
    expect(
      evaluateRequirements(rules, { ...measured, punishmentCount: 1 }, { now: NOW }).ok
    ).toBe(false);
  });
});

describe("form access code", () => {
  it("knows when a form is gated", () => {
    expect(requiresAccessCode({ accessCode: "letmein" })).toBe(true);
    expect(requiresAccessCode({ accessCode: "   " })).toBe(false);
    expect(requiresAccessCode({ accessCode: null })).toBe(false);
    expect(requiresAccessCode({})).toBe(false);
    expect(requiresAccessCode(null)).toBe(false);
  });

  it("accepts the right code", () => {
    expect(verifyAccessCode("letmein", "letmein")).toBe(true);
  });

  it("tolerates surrounding whitespace on both sides", () => {
    expect(verifyAccessCode("  letmein  ", "letmein ")).toBe(true);
  });

  it("rejects a wrong code, including a prefix of the right one", () => {
    expect(verifyAccessCode("letmein", "letmeout")).toBe(false);
    expect(verifyAccessCode("letmein", "letme")).toBe(false);
    expect(verifyAccessCode("letmein", "letmeinX")).toBe(false);
    expect(verifyAccessCode("letmein", "LETMEIN")).toBe(false);
  });

  it("compares codes of different lengths without throwing", () => {
    // timingSafeEqual rejects unequal buffers, so the implementation has to
    // hash first -- a length mismatch must be an ordinary false, not a crash.
    expect(() => verifyAccessCode("a", "a-much-longer-guess")).not.toThrow();
    expect(verifyAccessCode("a", "a-much-longer-guess")).toBe(false);
  });

  it("fails closed when there is no code to match", () => {
    expect(verifyAccessCode(null, "anything")).toBe(false);
    expect(verifyAccessCode("", "")).toBe(false);
    expect(verifyAccessCode("letmein", "")).toBe(false);
    expect(verifyAccessCode("letmein", null)).toBe(false);
  });

  it("remembers an unlocked form for the session, per slug", () => {
    const session = {};

    expect(hasUnlocked(session, "staff-application")).toBe(false);

    markUnlocked(session, "staff-application");

    expect(hasUnlocked(session, "staff-application")).toBe(true);
    expect(hasUnlocked(session, "builder-application")).toBe(false);
  });

  it("survives a session with junk in the slot", () => {
    const session = { formAccess: "not an object" };
    markUnlocked(session, "x");
    expect(hasUnlocked(session, "x")).toBe(true);
  });

  it("does not throw on a missing session", () => {
    expect(() => markUnlocked(null, "x")).not.toThrow();
    expect(hasUnlocked(null, "x")).toBe(false);
  });
});
