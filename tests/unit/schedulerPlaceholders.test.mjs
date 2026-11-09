import { describe, it, expect } from "vitest";
import {
  renderPlaceholders,
  collectUnknownPlaceholders,
  validateActionPlaceholders,
  applyActionPlaceholders,
  computeRunNumber,
} from "../../lib/scheduler/placeholders.mjs";

const SYD = "Australia/Sydney";

describe("renderPlaceholders - {date}", () => {
  it("formats the due date in the job timezone", () => {
    const ctx = { dueAt: new Date("2026-11-14T03:00:00Z"), timezone: SYD, runNumber: 1 };
    expect(renderPlaceholders("On {date}", ctx)).toBe("On 14 November 2026");
  });

  it("rolls to the next day around midnight in the timezone", () => {
    // 13:00Z = 00:00 Sydney (AEDT +11) on 15 Nov; 12:59Z = 23:59 on 14 Nov.
    const before = { dueAt: new Date("2026-11-14T12:59:00Z"), timezone: SYD, runNumber: 1 };
    const after = { dueAt: new Date("2026-11-14T13:00:00Z"), timezone: SYD, runNumber: 1 };
    expect(renderPlaceholders("{date}", before)).toBe("14 November 2026");
    expect(renderPlaceholders("{date}", after)).toBe("15 November 2026");
  });
});

describe("renderPlaceholders - {week}", () => {
  it("gives ISO week 53 for a date whose week belongs to the previous year", () => {
    // 1 Jan 2027 (Fri) belongs to ISO week 53 of 2026.
    const ctx = { dueAt: new Date("2027-01-01T01:00:00Z"), timezone: SYD, runNumber: 1 };
    expect(renderPlaceholders("W{week}", ctx)).toBe("W53");
  });

  it("gives ISO week 1 for a late-December date whose week starts in December", () => {
    // 29 Dec 2025 (Mon) belongs to ISO week 1 of 2026.
    const ctx = { dueAt: new Date("2025-12-29T02:00:00Z"), timezone: SYD, runNumber: 1 };
    expect(renderPlaceholders("W{week}", ctx)).toBe("W1");
  });
});

describe("renderPlaceholders - {runNumber} and escaping", () => {
  it("substitutes the run number", () => {
    expect(renderPlaceholders("Drop #{runNumber}", { dueAt: new Date(), timezone: SYD, runNumber: 12 })).toBe("Drop #12");
  });
  it("treats {{ and }} as literal braces", () => {
    expect(renderPlaceholders("{{literal}} {runNumber}", { dueAt: new Date(), timezone: SYD, runNumber: 3 })).toBe("{literal} 3");
  });
  it("throws on an unknown placeholder", () => {
    expect(() => renderPlaceholders("{nope}", { dueAt: new Date(), timezone: SYD, runNumber: 1 })).toThrow(/unknown placeholder/i);
  });
});

describe("collectUnknownPlaceholders / validateActionPlaceholders", () => {
  it("finds unknown names but ignores known ones and escapes", () => {
    expect(collectUnknownPlaceholders("{date} {week} {{escaped}} {typo}")).toEqual(["typo"]);
  });
  it("validates only the substitutable fields of an action", () => {
    const errs = validateActionPlaceholders("discord_message", { embedTitle: "Drop #{runNumber}", embedDescription: "{oops}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/embedDescription.*oops/);
  });
});

describe("applyActionPlaceholders", () => {
  it("fills command fields and rejects a newline in a command", () => {
    const ctx = { dueAt: new Date("2026-11-14T03:00:00Z"), timezone: SYD, runNumber: 5 };
    const out = applyActionPlaceholders("command", { target: "any", command: "say Drop #{runNumber} on {date}" }, ctx);
    expect(out.command).toBe("say Drop #5 on 14 November 2026");
    expect(() => applyActionPlaceholders("command", { command: "say {{\n}}" }, ctx)).toThrow(/newline/i);
  });
  it("does not touch routine payloads", () => {
    const out = applyActionPlaceholders("routine", { routineSlug: "weekly-{date}" }, { dueAt: new Date(), timezone: SYD, runNumber: 1 });
    expect(out.routineSlug).toBe("weekly-{date}"); // routines are not substituted
  });
});

describe("computeRunNumber", () => {
  it("starts at runNumberStart with no prior runs", () => {
    expect(computeRunNumber(1, [])).toBe(1);
    expect(computeRunNumber(12, [])).toBe(12);
  });
  it("counts only executed scheduled runs; missed/skipped/manual do not consume", () => {
    const prior = [
      { triggerType: "schedule", status: "succeeded" },
      { triggerType: "schedule", status: "failed" },
      { triggerType: "schedule", status: "partial" },
      { triggerType: "schedule", status: "missed" }, // not consumed
      { triggerType: "schedule", status: "skipped" }, // not consumed
      { triggerType: "manual", status: "succeeded" }, // not consumed
    ];
    expect(computeRunNumber(1, prior)).toBe(1 + 3);
    expect(computeRunNumber(12, prior)).toBe(12 + 3);
  });
});
