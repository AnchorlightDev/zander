import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- In-memory prisma that enforces the unique (jobId, dueAt, triggerType) claim.
const jobs = new Map();
let actions = [];
let runs = [];
const runKeys = new Set();
let runId = 0;
let runCalls = [];

const prisma = {
  scheduled_jobs: {
    findMany: async ({ where }) =>
      [...jobs.values()].filter((j) => j.enabled && j.nextRunAt && new Date(j.nextRunAt) <= where.nextRunAt.lte),
    findUnique: async ({ where }) => jobs.get(where.id) || null,
    update: async ({ where, data }) => { Object.assign(jobs.get(where.id), data); return jobs.get(where.id); },
  },
  scheduled_job_actions: {
    findMany: async ({ where }) => actions.filter((a) => a.jobId === where.jobId).sort((a, b) => a.sortOrder - b.sortOrder),
  },
  scheduled_job_runs: {
    create: async ({ data }) => {
      const key = `${data.jobId}|${new Date(data.dueAt).getTime()}|${data.triggerType}`;
      if (runKeys.has(key)) { const e = new Error("dup"); e.code = "P2002"; throw e; } // unique violation
      runKeys.add(key);
      const row = { id: ++runId, ...data };
      runs.push(row);
      return row;
    },
    findMany: async ({ where }) => runs.filter((r) => r.jobId === where.jobId),
    update: async ({ where, data }) => { const r = runs.find((x) => x.id === where.id); Object.assign(r, data); return r; },
  },
  $transaction: async (cb) => cb(prisma),
};

vi.mock("../../controllers/databaseController.js", () => ({ default: { query: vi.fn() }, prisma, withDeadlockRetry: async (fn) => fn() }));
vi.mock("../../lib/scheduler/actions/index.mjs", () => ({
  getActionModule: () => ({
    run: async (payload) => {
      runCalls.push(payload);
      if (payload.__throw) throw new Error("boom");
      return { status: payload.__status || "succeeded", message: "ok" };
    },
  }),
}));

const { processDueJob, executeActions, tick } = await import("../../services/schedulerRunner.mjs");

const CONFIG = { scheduler: { missedRunGraceHours: 6, webhookUrl: "https://webhook.example/x" } };
const GRACE = 6 * 3600_000;

function addJob(j) {
  const job = { id: j.id, title: j.title || `Job ${j.id}`, enabled: true, scheduleType: "recurring", frequency: "daily", recurInterval: 1, timeOfDay: "00:00", timezone: "UTC", runNumberStart: 1, ...j };
  jobs.set(job.id, job);
  return job;
}

beforeEach(() => {
  jobs.clear(); actions = []; runs = []; runKeys.clear(); runId = 0; runCalls = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});

describe("exactly-once claiming", () => {
  it("lets only one of two racing runners claim the same due run", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const job = addJob({ id: 1, nextRunAt: new Date("2026-06-15T11:59:00Z") });
    actions.push({ jobId: 1, sortOrder: 0, actionType: "command", payload: {}, continueOnError: false });

    const [a, b] = await Promise.all([
      processDueJob(jobs.get(1), { now, client: null, config: CONFIG, graceMs: GRACE }),
      processDueJob(jobs.get(1), { now, client: null, config: CONFIG, graceMs: GRACE }),
    ]);

    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runCalls).toHaveLength(1); // the action ran exactly once
  });
});

describe("missed-run rule", () => {
  it("records a run more than the grace window late as missed and does not execute it", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    addJob({ id: 2, nextRunAt: new Date("2026-06-15T04:00:00Z") }); // 8h late
    actions.push({ jobId: 2, sortOrder: 0, actionType: "command", payload: {}, continueOnError: false });

    const res = await processDueJob(jobs.get(2), { now, client: null, config: CONFIG, graceMs: GRACE });

    expect(res.status).toBe("missed");
    expect(runs[0].status).toBe("missed");
    expect(runCalls).toHaveLength(0); // nothing executed
    expect(fetch).toHaveBeenCalled(); // webhook alert
    expect(new Date(jobs.get(2).nextRunAt).getTime()).toBeGreaterThan(now.getTime()); // advanced past the backlog
  });

  it("executes a run that is only slightly late", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    addJob({ id: 3, nextRunAt: new Date("2026-06-15T11:00:00Z") }); // 1h late
    actions.push({ jobId: 3, sortOrder: 0, actionType: "command", payload: {}, continueOnError: false });

    const res = await processDueJob(jobs.get(3), { now, client: null, config: CONFIG, graceMs: GRACE });
    expect(res.status).toBe("succeeded");
    expect(runCalls).toHaveLength(1);
  });
});

describe("continueOnError", () => {
  it("continues past a failing action when continueOnError is set (partial)", async () => {
    addJob({ id: 4 });
    actions.push(
      { jobId: 4, sortOrder: 0, actionType: "command", payload: { __status: "failed" }, continueOnError: true },
      { jobId: 4, sortOrder: 1, actionType: "command", payload: { __status: "succeeded" }, continueOnError: false }
    );
    const { status, results } = await executeActions(jobs.get(4), {});
    expect(status).toBe("partial");
    expect(results.map((r) => r.status)).toEqual(["failed", "succeeded"]);
  });

  it("stops and skips later actions when continueOnError is not set (failed)", async () => {
    addJob({ id: 5 });
    actions.push(
      { jobId: 5, sortOrder: 0, actionType: "command", payload: { __status: "failed" }, continueOnError: false },
      { jobId: 5, sortOrder: 1, actionType: "command", payload: { __status: "succeeded" }, continueOnError: false }
    );
    const { status, results } = await executeActions(jobs.get(5), {});
    expect(status).toBe("failed");
    expect(results.map((r) => r.status)).toEqual(["failed", "skipped"]);
  });
});

describe("once jobs", () => {
  it("disables itself after it runs", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    addJob({ id: 6, scheduleType: "once", frequency: null, runAt: now, nextRunAt: new Date("2026-06-15T11:59:00Z") });
    actions.push({ jobId: 6, sortOrder: 0, actionType: "command", payload: {}, continueOnError: false });

    await processDueJob(jobs.get(6), { now, client: null, config: CONFIG, graceMs: GRACE });

    expect(jobs.get(6).enabled).toBe(false);
    expect(jobs.get(6).nextRunAt).toBeNull();
    expect(runs[0].status).toBe("succeeded");
  });
});

describe("tick", () => {
  it("processes every due enabled job", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    addJob({ id: 7, nextRunAt: new Date("2026-06-15T11:59:00Z") });
    addJob({ id: 8, nextRunAt: new Date("2026-06-15T11:58:00Z") });
    addJob({ id: 9, enabled: false, nextRunAt: new Date("2026-06-15T11:00:00Z") });
    for (const id of [7, 8, 9]) actions.push({ jobId: id, sortOrder: 0, actionType: "command", payload: {}, continueOnError: false });

    const count = await tick({ now, client: null, config: CONFIG });
    expect(count).toBe(2); // only the two enabled, due jobs
    expect(runs).toHaveLength(2);
  });
});
