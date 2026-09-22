/**
 * tests/unit/birthday.test.mjs
 *
 * Birthdays without a year, and the timezone handling that decides which day
 * "today" is. Pure -- no database, no clock beyond the one passed in.
 */

import { describe, expect, it } from "vitest";
import {
  celebratedDayInYear,
  formatBirthday,
  isBirthdayNow,
  normaliseBirthday,
  shouldGrantBirthday,
} from "../../lib/birthday.mjs";
import {
  groupedTimeZones,
  isValidTimeZone,
  listTimeZones,
  localDateParts,
  normaliseTimeZone,
} from "../../lib/timezones.mjs";

describe("normaliseBirthday", () => {
  it("accepts a real day of the year", () => {
    expect(normaliseBirthday(14, 3)).toEqual({ day: 14, month: 3 });
    expect(normaliseBirthday("14", "3")).toEqual({ day: 14, month: 3 });
  });

  it("accepts 29 February, because there is no year to rule it out", () => {
    expect(normaliseBirthday(29, 2)).toEqual({ day: 29, month: 2 });
  });

  it("rejects a day the month cannot have", () => {
    expect(normaliseBirthday(30, 2)).toBeNull();
    expect(normaliseBirthday(31, 4)).toBeNull();
    expect(normaliseBirthday(32, 1)).toBeNull();
  });

  it("rejects an impossible month, or half a birthday", () => {
    expect(normaliseBirthday(14, 0)).toBeNull();
    expect(normaliseBirthday(14, 13)).toBeNull();
    expect(normaliseBirthday(14, null)).toBeNull();
    expect(normaliseBirthday(null, 3)).toBeNull();
    expect(normaliseBirthday(undefined, undefined)).toBeNull();
    expect(normaliseBirthday(1.5, 3)).toBeNull();
  });
});

describe("formatBirthday", () => {
  it("reads as a day and a month, with no year to infer an age from", () => {
    expect(formatBirthday({ day: 14, month: 3 })).toBe("14 March");
    expect(formatBirthday({ day: 1, month: 12 })).toBe("1 December");
  });

  it("is empty when nothing is stored", () => {
    expect(formatBirthday(null)).toBe("");
    expect(formatBirthday({})).toBe("");
  });
});

describe("29 February", () => {
  it("is itself in a leap year", () => {
    expect(celebratedDayInYear({ day: 29, month: 2 }, 2028)).toEqual({ month: 2, day: 29 });
  });

  it("moves to the 28th in a common year, not into March", () => {
    // Nobody born on the 29th should be skipped three years in four, and the
    // greeting belongs in February.
    expect(celebratedDayInYear({ day: 29, month: 2 }, 2026)).toEqual({ month: 2, day: 28 });
    expect(celebratedDayInYear({ day: 29, month: 2 }, 2027)).toEqual({ month: 2, day: 28 });
  });

  it("leaves every other date alone", () => {
    expect(celebratedDayInYear({ day: 31, month: 12 }, 2026)).toEqual({ month: 12, day: 31 });
    expect(celebratedDayInYear({ day: 1, month: 1 }, 2026)).toEqual({ month: 1, day: 1 });
  });

  it("is null for nothing stored", () => {
    expect(celebratedDayInYear(null, 2026)).toBeNull();
  });
});

describe("isBirthdayNow", () => {
  const birthday = { day: 15, month: 3 };

  it("is true on the day in the viewer's own zone", () => {
    expect(isBirthdayNow(birthday, {
      now: new Date("2026-03-15T03:00:00Z"),
      zone: "Australia/Brisbane",
    })).toBe(true);
  });

  it("is already true in Brisbane while it is still yesterday in UTC", () => {
    // 20:00 UTC on the 14th is 06:00 on the 15th in Brisbane. This is the
    // whole reason a timezone is stored.
    const instant = new Date("2026-03-14T20:00:00Z");

    expect(isBirthdayNow(birthday, { now: instant, zone: "Australia/Brisbane" })).toBe(true);
    expect(isBirthdayNow(birthday, { now: instant, zone: "UTC" })).toBe(false);
  });

  it("is still true in Los Angeles when UTC has already rolled over", () => {
    const instant = new Date("2026-03-16T04:00:00Z"); // 21:00 on the 15th in LA
    expect(isBirthdayNow(birthday, { now: instant, zone: "America/Los_Angeles" })).toBe(true);
    expect(isBirthdayNow(birthday, { now: instant, zone: "UTC" })).toBe(false);
  });

  it("falls back to UTC when no zone is stored", () => {
    expect(isBirthdayNow(birthday, { now: new Date("2026-03-15T12:00:00Z") })).toBe(true);
    expect(isBirthdayNow(birthday, { now: new Date("2026-03-16T12:00:00Z") })).toBe(false);
  });

  it("is false on any other day, and for nothing stored", () => {
    expect(isBirthdayNow(birthday, { now: new Date("2026-07-01T12:00:00Z") })).toBe(false);
    expect(isBirthdayNow(null, { now: new Date("2026-03-15T12:00:00Z") })).toBe(false);
  });
});

describe("shouldGrantBirthday", () => {
  const base = { birthdayDay: 15, birthdayMonth: 3, timezone: "Australia/Brisbane" };
  const onTheDay = new Date("2026-03-15T03:00:00Z");

  it("grants on the day", () => {
    expect(shouldGrantBirthday({ ...base, birthdayLastGrantedYear: null }, { now: onTheDay })).toBe(true);
  });

  it("does not grant twice in the same year", () => {
    // The job runs hourly because midnight arrives 24 times; without this it
    // would grant on every one of those runs.
    expect(shouldGrantBirthday({ ...base, birthdayLastGrantedYear: 2026 }, { now: onTheDay })).toBe(false);
  });

  it("grants again the following year", () => {
    expect(shouldGrantBirthday(
      { ...base, birthdayLastGrantedYear: 2025 },
      { now: onTheDay }
    )).toBe(true);
  });

  it("uses the local year, not the UTC year", () => {
    // 1 January in Brisbane is still 31 December in UTC.
    const newYear = new Date("2025-12-31T14:00:00Z");
    const user = { birthdayDay: 1, birthdayMonth: 1, timezone: "Australia/Brisbane" };

    expect(shouldGrantBirthday({ ...user, birthdayLastGrantedYear: 2026 }, { now: newYear })).toBe(false);
    expect(shouldGrantBirthday({ ...user, birthdayLastGrantedYear: 2025 }, { now: newYear })).toBe(true);
  });

  it("does not grant to someone who has not set one", () => {
    expect(shouldGrantBirthday({ timezone: "UTC" }, { now: onTheDay })).toBe(false);
    expect(shouldGrantBirthday({}, { now: onTheDay })).toBe(false);
    expect(shouldGrantBirthday(null, { now: onTheDay })).toBe(false);
  });

  it("does not grant on the wrong day", () => {
    expect(shouldGrantBirthday(base, { now: new Date("2026-03-20T03:00:00Z") })).toBe(false);
  });
});

describe("time zones", () => {
  it("offers the runtime's own IANA list rather than a hard-coded one", () => {
    const zones = listTimeZones();

    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain("Australia/Brisbane");
    expect(zones).toContain("Europe/London");
    expect([...zones]).toEqual([...zones].sort());
  });

  it("validates by trying to use the zone", () => {
    expect(isValidTimeZone("Australia/Brisbane")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it("normalises to null rather than keeping junk", () => {
    expect(normaliseTimeZone(" Europe/London ")).toBe("Europe/London");
    expect(normaliseTimeZone("not a zone")).toBeNull();
  });

  it("groups for a dropdown, with readable labels", () => {
    const groups = groupedTimeZones();
    const australia = groups.find((g) => g.region === "Australia");

    expect(australia.zones.some((z) => z.value === "Australia/Broken_Hill" && z.label === "Broken Hill")).toBe(true);
  });

  it("reads the wall-clock date in a zone", () => {
    expect(localDateParts(new Date("2026-03-14T20:00:00Z"), "Australia/Brisbane"))
      .toEqual({ year: 2026, month: 3, day: 15 });
    expect(localDateParts(new Date("2026-03-14T20:00:00Z"), "UTC"))
      .toEqual({ year: 2026, month: 3, day: 14 });
  });

  it("falls back to UTC for an unusable zone instead of throwing", () => {
    expect(localDateParts(new Date("2026-03-14T20:00:00Z"), "Mars/Olympus_Mons"))
      .toEqual({ year: 2026, month: 3, day: 14 });
    expect(localDateParts("not a date", "UTC")).toBeNull();
  });
});
