import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { nextOccurrence, upcoming } from "../../lib/scheduler/recurrence.mjs";

const SYD = "Australia/Sydney";
const local = (date) => DateTime.fromJSDate(date, { zone: SYD });
const at = (date) => local(date).toFormat("yyyy-MM-dd HH:mm");

describe("nextOccurrence - once", () => {
  it("returns runAt when future, null when past", () => {
    const job = { scheduleType: "once", runAt: "2027-01-01T00:00:00Z" };
    expect(nextOccurrence(job, "2026-01-01T00:00:00Z").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(nextOccurrence(job, "2027-02-01T00:00:00Z")).toBeNull();
  });
});

describe("daily", () => {
  it("fires every day at the local time", () => {
    const job = { scheduleType: "recurring", frequency: "daily", recurInterval: 1, timeOfDay: "09:00", timezone: SYD };
    // 00:00Z on 15 Jun is 10:00 Sydney, so that day's 09:00 has already passed.
    const next = nextOccurrence(job, "2026-06-15T00:00:00Z");
    expect(at(next)).toBe("2026-06-16 09:00");
    const five = upcoming(job, 3, "2026-06-15T00:00:00Z").map(at);
    expect(five).toEqual(["2026-06-16 09:00", "2026-06-17 09:00", "2026-06-18 09:00"]);
  });

  it("honours an interval of 2 days from the anchor", () => {
    const job = { scheduleType: "recurring", frequency: "daily", recurInterval: 2, timeOfDay: "09:00", timezone: SYD, runAt: "2026-06-10T00:00:00Z" };
    const days = upcoming(job, 3, "2026-06-15T00:00:00Z").map((d) => local(d).toFormat("yyyy-MM-dd"));
    // anchor 2026-06-10; every 2 days => 10,12,14,16,18...
    expect(days).toEqual(["2026-06-16", "2026-06-18", "2026-06-20"]);
  });
});

describe("weekly", () => {
  it("fires on Fridays at 18:00", () => {
    const job = { scheduleType: "recurring", frequency: "weekly", recurInterval: 1, byWeekday: "FRI", timeOfDay: "18:00", timezone: SYD };
    const next = nextOccurrence(job, "2026-06-15T00:00:00Z"); // Mon 15 Jun 2026
    expect(at(next)).toBe("2026-06-19 18:00"); // the coming Friday
    expect(local(next).weekday).toBe(5);
  });

  it("fires on several weekdays", () => {
    const job = { scheduleType: "recurring", frequency: "weekly", recurInterval: 1, byWeekday: "1,3,5", timeOfDay: "12:00", timezone: SYD };
    const days = upcoming(job, 3, "2026-06-15T00:00:00Z").map((d) => local(d).toFormat("cccc"));
    expect(days).toEqual(["Monday", "Wednesday", "Friday"]);
  });

  it("honours an interval of 2 weeks", () => {
    const job = { scheduleType: "recurring", frequency: "weekly", recurInterval: 2, byWeekday: "MON", timeOfDay: "10:00", timezone: SYD, runAt: "2026-06-01T00:00:00Z" };
    const days = upcoming(job, 3, "2026-06-02T00:00:00Z").map((d) => local(d).toFormat("yyyy-MM-dd"));
    // anchor week starts Mon 1 Jun; every 2 weeks: 15 Jun, 29 Jun, 13 Jul
    expect(days).toEqual(["2026-06-15", "2026-06-29", "2026-07-13"]);
  });
});

describe("monthly", () => {
  it("fires on the given day of the month", () => {
    const job = { scheduleType: "recurring", frequency: "monthly", recurInterval: 1, byMonthDay: 15, timeOfDay: "08:00", timezone: SYD };
    const days = upcoming(job, 3, "2026-06-20T00:00:00Z").map((d) => local(d).toFormat("yyyy-MM-dd"));
    expect(days).toEqual(["2026-07-15", "2026-08-15", "2026-09-15"]);
  });

  it("clamps day 31 to the last day of shorter months", () => {
    const job = { scheduleType: "recurring", frequency: "monthly", recurInterval: 1, byMonthDay: 31, timeOfDay: "08:00", timezone: SYD };
    const days = upcoming(job, 4, "2026-01-15T00:00:00Z").map((d) => local(d).toFormat("yyyy-MM-dd"));
    // Jan 31, Feb 28 (2026 not leap), Mar 31, Apr 30
    expect(days).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });
});

describe("untilDate", () => {
  it("stops after the until date", () => {
    const job = { scheduleType: "recurring", frequency: "daily", recurInterval: 1, timeOfDay: "09:00", timezone: SYD, untilDate: "2026-06-17T00:00:00Z" };
    const days = upcoming(job, 10, "2026-06-15T00:00:00Z").map((d) => local(d).toFormat("yyyy-MM-dd"));
    // 00:00Z 15 Jun = 10:00 Sydney, so 15 Jun 09:00 has passed. 16 Jun 09:00 =
    // 23:00Z 15 Jun and 17 Jun 09:00 = 23:00Z 16 Jun are both before the until.
    expect(days).toEqual(["2026-06-16", "2026-06-17"]);
    // nothing after the until date
    expect(upcoming(job, 10, "2026-06-18T00:00:00Z")).toEqual([]);
  });
});

describe("daylight saving - Australia/Sydney", () => {
  it("moves a nonexistent spring-forward time to the first valid minute (02:30 -> 03:00 on 4 Oct 2026)", () => {
    const job = { scheduleType: "recurring", frequency: "daily", recurInterval: 1, timeOfDay: "02:30", timezone: SYD };
    // after start of 4 Oct local
    const next = nextOccurrence(job, DateTime.fromObject({ year: 2026, month: 10, day: 4, hour: 0, minute: 0 }, { zone: SYD }).toJSDate());
    const dt = local(next);
    expect(dt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-10-04 03:00");
    expect(dt.offset).toBe(11 * 60); // AEDT
  });

  it("uses the first occurrence of an ambiguous autumn time (02:30 on 5 Apr 2026)", () => {
    const job = { scheduleType: "recurring", frequency: "daily", recurInterval: 1, timeOfDay: "02:30", timezone: SYD };
    const next = nextOccurrence(job, DateTime.fromObject({ year: 2026, month: 4, day: 5, hour: 0, minute: 0 }, { zone: SYD }).toJSDate());
    const dt = local(next);
    expect(dt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-04-05 02:30");
    expect(dt.offset).toBe(11 * 60); // AEDT = the earlier, first occurrence
  });
});
