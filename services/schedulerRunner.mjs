/**
 * services/schedulerRunner.mjs
 *
 * The scheduler job runner. Every minute cron/schedulerCron.js calls tick(),
 * which finds due jobs, claims each run exactly once (a unique insert on
 * scheduled_job_runs), advances nextRunAt in the same transaction, then executes
 * the job's actions in order and records per-action results.
 */
import { prisma } from "../controllers/databaseController.js";
import { nextOccurrence } from "../lib/scheduler/recurrence.mjs";
import { getActionModule } from "../lib/scheduler/actions/index.mjs";
import { applyActionPlaceholders, computeRunNumber } from "../lib/scheduler/placeholders.mjs";
import { resolveAvatarUrl } from "../lib/avatarHelpers.js";

const EXECUTED_STATUSES = ["succeeded", "partial", "failed"];

/** Post a short failure/missed alert to the scheduler webhook, if configured. */
async function alert(config, content) {
  const url = config?.scheduler?.webhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
  } catch (e) {
    console.error("[schedulerRunner] webhook alert failed:", e?.message || e);
  }
}

/**
 * Execute a job's actions in order. Returns { status, results }.
 *   succeeded - every action succeeded (a queued command counts as success)
 *   partial   - some succeeded, some failed
 *   failed    - none succeeded
 * A failed action stops the run unless it has continueOnError; later actions are
 * recorded as skipped.
 */
export async function executeActions(job, ctx) {
  const actions = await prisma.scheduled_job_actions.findMany({
    where: { jobId: job.id },
    orderBy: { sortOrder: "asc" },
  });

  const results = [];
  let anySuccess = false;
  let anyFail = false;
  let stopped = false;

  for (const action of actions) {
    if (stopped) {
      results.push({ actionType: action.actionType, status: "skipped", message: "A previous action failed." });
      continue;
    }
    const mod = getActionModule(action.actionType);
    try {
      if (!mod) throw new Error(`Unknown action type "${action.actionType}".`);
      const payload = applyActionPlaceholders(action.actionType, action.payload || {}, ctx);
      const r = await mod.run(payload, ctx);
      results.push({ actionType: action.actionType, status: r.status, message: r.message, refs: r.refs });
      if (r.status === "failed") {
        anyFail = true;
        if (!action.continueOnError) stopped = true;
      } else {
        anySuccess = true; // succeeded or queued
      }
    } catch (e) {
      results.push({ actionType: action.actionType, status: "failed", message: e?.message || String(e) });
      anyFail = true;
      if (!action.continueOnError) stopped = true;
    }
  }

  const status = anyFail && anySuccess ? "partial" : anyFail ? "failed" : "succeeded";
  return { status, results };
}

/**
 * Claim a scheduled run and advance nextRunAt in one transaction. Returns the run
 * row, or null if another instance already claimed it (duplicate key).
 */
async function claimScheduledRun(job, dueAt, { missed, now, runNumber }) {
  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.scheduled_job_runs.create({
        data: {
          jobId: job.id,
          dueAt,
          status: missed ? "missed" : "running",
          startedAt: missed ? null : now,
          triggerType: "schedule",
          // Missed runs do not consume a number; executed runs store theirs.
          runNumber: missed ? null : runNumber,
        },
      });

      // Advance. A missed run skips the backlog (next occurrence after now);
      // a normal run advances to the next occurrence after this due time.
      const next = nextOccurrence(job, missed ? now : dueAt);
      if (job.scheduleType === "once") {
        await tx.scheduled_jobs.update({ where: { id: job.id }, data: { nextRunAt: null, enabled: false } });
      } else {
        await tx.scheduled_jobs.update({ where: { id: job.id }, data: { nextRunAt: next } });
      }
      return run;
    });
  } catch (e) {
    if (e?.code === "P2002") return null; // another instance won the claim
    throw e;
  }
}

/**
 * The job creator's username and avatar for "Scheduled by" footers.
 * scheduled_jobs stores only createdBy (a user id). Best effort: a lookup
 * failure falls back to the default footer rather than failing the run.
 */
async function resolveActor(userId) {
  if (!userId) return { actorUsername: null, actorAvatarUrl: null };
  try {
    const user = await prisma.users.findUnique({
      where: { userId: Number(userId) },
      select: { userId: true, uuid: true, username: true, profilePicture_type: true, profilePicture_email: true },
    });
    if (!user) return { actorUsername: null, actorAvatarUrl: null };
    return { actorUsername: user.username || null, actorAvatarUrl: await resolveAvatarUrl(user) };
  } catch (e) {
    console.error("[schedulerRunner] creator lookup failed:", e?.message || e);
    return { actorUsername: null, actorAvatarUrl: null };
  }
}

/** Process one due job: claim, apply the missed rule, execute, record results. */
export async function processDueJob(job, { now = new Date(), client, config, graceMs }) {
  const dueAt = job.nextRunAt ? new Date(job.nextRunAt) : null;
  if (!dueAt) return null;

  const priorRuns = await prisma.scheduled_job_runs.findMany({ where: { jobId: job.id } });
  const runNumber = computeRunNumber(job.runNumberStart, priorRuns);
  const missed = now.getTime() - dueAt.getTime() > graceMs;

  const run = await claimScheduledRun(job, dueAt, { missed, now, runNumber });
  if (!run) return null; // already claimed by another instance

  if (missed) {
    await alert(config, `:warning: Scheduled job "${job.title}" missed a run due at ${dueAt.toISOString()} (more than the grace window late).`);
    return { runId: run.id, status: "missed" };
  }

  const ctx = {
    client,
    config,
    dueAt,
    runNumber,
    timezone: job.timezone,
    ...(await resolveActor(job.createdBy)),
  };
  const { status, results } = await executeActions(job, ctx);

  await prisma.scheduled_job_runs.update({
    where: { id: run.id },
    data: { status, finishedAt: new Date(), results },
  });

  if (status === "failed" || status === "partial") {
    await alert(config, `:x: Scheduled job "${job.title}" run ${status}. ${results.filter((r) => r.status === "failed").map((r) => r.message).join("; ")}`);
  }

  return { runId: run.id, status };
}

/** The per-minute entry point: run every due, enabled job. */
export async function tick({ now = new Date(), client, config } = {}) {
  const graceMs = (config?.scheduler?.missedRunGraceHours ?? 6) * 3600_000;
  const jobs = await prisma.scheduled_jobs.findMany({
    where: { enabled: true, nextRunAt: { not: null, lte: now } },
  });
  for (const job of jobs) {
    try {
      await processDueJob(job, { now, client, config, graceMs });
    } catch (e) {
      console.error(`[schedulerRunner] job ${job.id} failed:`, e?.message || e);
    }
  }
  return jobs.length;
}

/**
 * Manual "Run now": uses the number the next scheduled run would get but stores
 * runNumber = null (it does not consume one). Trigger is 'manual'.
 */
export async function runJobNow(jobId, triggeredBy, { client, config, now = new Date() } = {}) {
  const job = await prisma.scheduled_jobs.findUnique({ where: { id: Number(jobId) } });
  if (!job) throw new Error(`Job ${jobId} not found.`);

  const priorRuns = await prisma.scheduled_job_runs.findMany({ where: { jobId: job.id } });
  const runNumber = computeRunNumber(job.runNumberStart, priorRuns);

  const run = await prisma.scheduled_job_runs.create({
    data: { jobId: job.id, dueAt: now, status: "running", startedAt: now, triggerType: "manual", triggeredBy: triggeredBy ?? null, runNumber: null },
  });

  const ctx = { client, config, dueAt: now, runNumber, timezone: job.timezone, ...(await resolveActor(job.createdBy)) };
  const { status, results } = await executeActions(job, ctx);

  await prisma.scheduled_job_runs.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), results } });

  if (status === "failed" || status === "partial") {
    await alert(config, `:x: Manual run of "${job.title}" ${status}.`);
  }
  return { runId: run.id, status };
}
