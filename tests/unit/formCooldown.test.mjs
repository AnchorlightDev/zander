/**
 * tests/unit/formCooldown.test.mjs
 *
 * Reapply-cooldown arithmetic, against a fixed clock.
 */

import { describe, expect, it } from "vitest";
import {
  cooldownEndsAt,
  evaluateCooldown,
  formatCooldownDate,
} from "../../lib/formCooldown.mjs";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const DAY = 86400000;

const denialAt = (date) => ({ reviewedAt: date });

describe("cooldownEndsAt", () => {
  it("adds the cooldown to the decision time, not the application time", () => {
    const reviewedAt = new Date("2026-09-01T09:30:00.000Z");
    expect(cooldownEndsAt(reviewedAt, 30).toISOString()).toBe("2026-10-01T09:30:00.000Z");
  });

  it("accepts a date that came back from the database as a string", () => {
    expect(cooldownEndsAt("2026-09-01T09:30:00.000Z", 7).toISOString()).toBe(
      "2026-09-08T09:30:00.000Z"
    );
  });

  it("is null when there is no cooldown configured", () => {
    expect(cooldownEndsAt(NOW, null)).toBeNull();
    expect(cooldownEndsAt(NOW, 0)).toBeNull();
    expect(cooldownEndsAt(NOW, -5)).toBeNull();
  });

  it("is null when there is nothing to count from", () => {
    expect(cooldownEndsAt(null, 30)).toBeNull();
    expect(cooldownEndsAt("not a date", 30)).toBeNull();
  });
});

describe("evaluateCooldown", () => {
  it("does not block when the form has no cooldown", () => {
    const result = evaluateCooldown({
      lastDenial: denialAt(NOW),
      cooldownDays: null,
      now: NOW,
    });

    expect(result).toEqual({ blocked: false, until: null, message: null });
  });

  it("does not block someone who has never been denied", () => {
    expect(evaluateCooldown({ lastDenial: null, cooldownDays: 30, now: NOW }).blocked).toBe(false);
  });

  it("blocks inside the window and names the exact date", () => {
    const result = evaluateCooldown({
      lastDenial: denialAt(new Date(NOW.getTime() - 10 * DAY)),
      cooldownDays: 30,
      now: NOW,
    });

    expect(result.blocked).toBe(true);
    expect(result.until.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(result.message).toBe(
      "Your last application was not successful. You can apply again on 12 October 2026."
    );
  });

  describe("the boundary", () => {
    const reviewedAt = new Date("2026-09-01T12:00:00.000Z");

    it("blocks one millisecond before the cooldown ends", () => {
      const now = new Date(reviewedAt.getTime() + 30 * DAY - 1);
      expect(evaluateCooldown({ lastDenial: denialAt(reviewedAt), cooldownDays: 30, now }).blocked)
        .toBe(true);
    });

    it("lets them through at exactly the moment it ends", () => {
      const now = new Date(reviewedAt.getTime() + 30 * DAY);
      expect(evaluateCooldown({ lastDenial: denialAt(reviewedAt), cooldownDays: 30, now }).blocked)
        .toBe(false);
    });

    it("lets them through afterwards", () => {
      const now = new Date(reviewedAt.getTime() + 31 * DAY);
      expect(evaluateCooldown({ lastDenial: denialAt(reviewedAt), cooldownDays: 30, now }).blocked)
        .toBe(false);
    });
  });

  it("does not block on a denial that was never given a decision time", () => {
    // A row decided before reviewedAt was populated would otherwise be a
    // permanent block with nothing to count from.
    const result = evaluateCooldown({
      lastDenial: denialAt(null),
      cooldownDays: 30,
      now: NOW,
    });

    expect(result.blocked).toBe(false);
  });

  it("defaults to no arguments meaning no block", () => {
    expect(evaluateCooldown().blocked).toBe(false);
  });
});

describe("formatCooldownDate", () => {
  it("formats in UTC, independent of the host's locale", () => {
    expect(formatCooldownDate(new Date("2026-10-12T12:00:00.000Z"))).toBe("12 October 2026");
    expect(formatCooldownDate(new Date("2027-01-01T00:00:00.000Z"))).toBe("1 January 2027");
  });

  it("returns an empty string for a date it cannot read", () => {
    expect(formatCooldownDate("not a date")).toBe("");
  });
});
