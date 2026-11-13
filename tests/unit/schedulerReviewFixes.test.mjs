import { describe, it, expect, vi } from "vitest";

vi.mock("../../controllers/databaseController.js", () => ({ prisma: {}, withDeadlockRetry: (fn) => fn(), default: {} }));

const { leadTimeErrors } = await import("../../services/schedulerJobService.mjs");
const { computeRunNumber } = await import("../../lib/scheduler/placeholders.mjs");

const NOW = new Date("2026-11-14T00:00:00Z");
const inMinutes = (m) => new Date(NOW.getTime() + m * 60000);

describe("leadTimeErrors", () => {
  it("allows anything when no lead time is required (dashboard)", () => {
    expect(leadTimeErrors(inMinutes(1), NOW, 0)).toEqual([]);
  });

  it("rejects a run sooner than the lead time, including one already due", () => {
    expect(leadTimeErrors(inMinutes(1), NOW, 15)).toHaveLength(1);
    expect(leadTimeErrors(inMinutes(-5), NOW, 15)).toHaveLength(1);
  });

  it("accepts a run at or beyond the lead time, or no run at all", () => {
    expect(leadTimeErrors(inMinutes(15), NOW, 15)).toEqual([]);
    expect(leadTimeErrors(inMinutes(60 * 24), NOW, 15)).toEqual([]);
    expect(leadTimeErrors(null, NOW, 15)).toEqual([]);
  });
});

describe("computeRunNumber with a run left running", () => {
  it("counts a scheduled run stuck in 'running' so its number is not reused", () => {
    const prior = [
      { triggerType: "schedule", status: "succeeded" },
      { triggerType: "schedule", status: "running" },
      { triggerType: "manual", status: "running" },
    ];
    expect(computeRunNumber(1, prior)).toBe(3);
  });
});
