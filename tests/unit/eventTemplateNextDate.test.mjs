import { describe, it, expect, vi } from "vitest";

vi.mock("../../controllers/databaseController.js", () => ({ prisma: {}, default: {} }));

const { computeNextEventDate, eventPrefillFromTemplate, recurrenceDaysOf, templateTimesOn } = await import("../../services/eventTemplateService.js");

// Wednesday 1 October 2025, UTC.
const WEDNESDAY = new Date("2025-10-01T10:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);

describe("recurrenceDaysOf", () => {
  it("reads days stored as an array or as a JSON string", () => {
    expect(recurrenceDaysOf({ recurrenceDays: [5, 1] })).toEqual([1, 5]);
    expect(recurrenceDaysOf({ recurrenceDays: "[5,1]" })).toEqual([1, 5]);
    expect(recurrenceDaysOf({ recurrenceDays: "5,1" })).toEqual([1, 5]);
  });

  it("drops anything that is not a weekday number", () => {
    expect(recurrenceDaysOf({ recurrenceDays: [1, 1, 9, "x", -1] })).toEqual([1]);
    expect(recurrenceDaysOf({ recurrenceDays: null })).toEqual([]);
  });
});

describe("computeNextEventDate", () => {
  it("finds the next weekly day when days are stored as a JSON string", () => {
    // Previously returned null, which surfaced as "Could not determine next event date".
    const next = computeNextEventDate({ recurrenceType: "weekly", recurrenceDays: "[5]" }, WEDNESDAY);
    expect(iso(next)).toBe("2025-10-03"); // Friday
  });

  it("wraps to next week, and sorts days numerically", () => {
    const next = computeNextEventDate({ recurrenceType: "weekly", recurrenceDays: [10 - 9, 0] }, WEDNESDAY);
    expect(iso(next)).toBe("2025-10-05"); // Sunday comes before next Monday
  });

  it("has no date of its own for a master (once-off) template", () => {
    expect(computeNextEventDate({ recurrenceType: "once" }, WEDNESDAY)).toBeNull();
  });

  it("returns null for a weekly template with no days", () => {
    expect(computeNextEventDate({ recurrenceType: "weekly", recurrenceDays: [] }, WEDNESDAY)).toBeNull();
  });

  it("handles daily templates", () => {
    expect(iso(computeNextEventDate({ recurrenceType: "daily" }, WEDNESDAY))).toBe("2025-10-02");
  });
});

describe("eventPrefillFromTemplate", () => {
  const template = {
    templateId: 7,
    title: "Game Night",
    description: "<p>Fun</p>",
    visibility: "rank",
    teaserPublic: false,
    defaultStartTime: "09:30",
    defaultEndTime: "08:00",
    rankAccess: [{ rankSlug: "supporter" }],
    defaultHosts: [{ userId: 3, discordUserId: "9", displayName: "Host", role: "host" }],
    announcements: [{ label: "Reminder", triggerType: "before_event", offsetMinutes: 60, enabled: true }],
  };

  it("leaves the date to the organiser for a master template", () => {
    const ev = eventPrefillFromTemplate(template, null);
    expect(ev.templateId).toBe(7);
    expect(ev.title).toBe("Game Night");
    expect(ev.startAt).toBeUndefined();
    expect(ev.rankAccess).toEqual([{ rankSlug: "supporter" }]);
    expect(ev.hosts[0].displayName).toBe("Host");
    expect(ev.announcements[0].label).toBe("Reminder");
    expect(ev.teaserPublic).toBe(false);
  });

  it("fills the date and default times when one is given, running overnight if needed", () => {
    const ev = eventPrefillFromTemplate(template, new Date("2025-10-03T00:00:00Z"));
    expect(ev.startAt).toBe("2025-10-03T09:30:00.000Z");
    expect(ev.endAt).toBe("2025-10-04T08:00:00.000Z");
  });

  it("names a broken default time instead of throwing 'Invalid time value'", () => {
    expect(() => templateTimesOn({ defaultStartTime: "6pm" }, new Date("2025-10-03T00:00:00Z"))).toThrow(/default start time "6pm"/);
  });
});
