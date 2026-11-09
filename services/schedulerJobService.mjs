/**
 * services/schedulerJobService.mjs
 *
 * CRUD + validation for scheduled jobs and their ordered actions. Dashboard and
 * MCP call these in-process. nextRunAt is computed from the recurrence engine on
 * every save, enable and action change.
 */
import { DateTime } from "luxon";
import { prisma, withDeadlockRetry } from "../controllers/databaseController.js";
import { nextOccurrence, upcoming } from "../lib/scheduler/recurrence.mjs";
import { validateAction, getActionModule } from "../lib/scheduler/actions/index.mjs";
import { validateActionPlaceholders } from "../lib/scheduler/placeholders.mjs";

const FREQUENCIES = ["daily", "weekly", "monthly"];

export function validateJob(input = {}) {
  const errors = [];
  if (!input.title || !String(input.title).trim()) errors.push("A title is required.");

  if (input.scheduleType === "once") {
    if (!input.runAt || Number.isNaN(new Date(input.runAt).getTime())) errors.push("A one-off job needs a valid run time.");
  } else if (input.scheduleType === "recurring") {
    if (!FREQUENCIES.includes(input.frequency)) errors.push("Choose a recurrence frequency.");
    if (input.timeOfDay && !/^\d{1,2}:\d{2}$/.test(String(input.timeOfDay))) errors.push("Time of day must be HH:MM.");
    if (!DateTime.now().setZone(input.timezone || "Australia/Sydney").isValid) errors.push("Timezone is not a valid IANA name.");
    if (input.frequency === "weekly" && !String(input.byWeekday || "").trim()) errors.push("Choose at least one weekday.");
    if (input.frequency === "monthly" && !(Number(input.byMonthDay) >= 1 && Number(input.byMonthDay) <= 31)) errors.push("Choose a day of the month (1-31).");
  } else {
    errors.push("Schedule type must be once or recurring.");
  }

  const actions = Array.isArray(input.actions) ? input.actions : [];
  if (actions.length === 0) errors.push("Add at least one action.");
  actions.forEach((a, i) => {
    const label = `Action ${i + 1}`;
    for (const e of validateAction(a.actionType, a.payload || {})) errors.push(`${label}: ${e}`);
    for (const e of validateActionPlaceholders(a.actionType, a.payload || {})) errors.push(`${label}: ${e}`);
  });

  return errors;
}

/** Build the persisted job columns from input (minus actions). */
function jobData(input, now) {
  const recurring = input.scheduleType === "recurring";
  return {
    title: String(input.title).slice(0, 160),
    description: input.description || null,
    enabled: input.enabled !== false,
    scheduleType: input.scheduleType,
    runAt: input.scheduleType === "once" && input.runAt ? new Date(input.runAt) : null,
    frequency: recurring ? input.frequency : null,
    recurInterval: recurring ? Math.max(1, Number(input.recurInterval) || 1) : 1,
    byWeekday: recurring && input.frequency === "weekly" ? String(input.byWeekday || "") : null,
    byMonthDay: recurring && input.frequency === "monthly" ? Number(input.byMonthDay) : null,
    timeOfDay: recurring ? (input.timeOfDay || "00:00") : null,
    timezone: input.timezone || "Australia/Sydney",
    untilDate: recurring && input.untilDate ? new Date(input.untilDate) : null,
    runNumberStart: Math.max(1, Number(input.runNumberStart) || 1),
    updatedAt: now,
  };
}

function computeNextRunAt(jobLike, now) {
  return nextOccurrence({ ...jobLike, createdAt: jobLike.createdAt || now }, now);
}

function actionRows(actions) {
  return actions.map((a, i) => ({
    sortOrder: Number.isFinite(a.sortOrder) ? a.sortOrder : i,
    actionType: a.actionType,
    payload: a.payload || {},
    continueOnError: !!a.continueOnError,
  }));
}

export async function createJob(input, createdBy = null) {
  const errors = validateJob(input);
  if (errors.length) { const e = new Error(errors.join(" ")); e.errors = errors; throw e; }

  const now = new Date();
  const data = jobData(input, now);
  const nextRunAt = computeNextRunAt({ ...data, createdAt: now }, now);

  const id = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    const job = await tx.scheduled_jobs.create({ data: { ...data, nextRunAt, createdBy, updatedBy: createdBy, createdAt: now } });
    for (const row of actionRows(input.actions)) {
      await tx.scheduled_job_actions.create({ data: { jobId: job.id, ...row } });
    }
    return job.id;
  }), { label: "createJob" });

  return id;
}

export async function updateJob(id, input, updatedBy = null) {
  const errors = validateJob(input);
  if (errors.length) { const e = new Error(errors.join(" ")); e.errors = errors; throw e; }

  const now = new Date();
  const data = jobData(input, now);
  const existing = await prisma.scheduled_jobs.findUnique({ where: { id: Number(id) } });
  if (!existing) throw new Error(`Job ${id} not found.`);
  const nextRunAt = data.enabled ? computeNextRunAt({ ...data, createdAt: existing.createdAt }, now) : null;

  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await tx.scheduled_jobs.update({ where: { id: Number(id) }, data: { ...data, nextRunAt, updatedBy } });
    await tx.scheduled_job_actions.deleteMany({ where: { jobId: Number(id) } });
    for (const row of actionRows(input.actions)) {
      await tx.scheduled_job_actions.create({ data: { jobId: Number(id), ...row } });
    }
  }), { label: "updateJob" });
}

export async function getJob(id) {
  const job = await prisma.scheduled_jobs.findUnique({
    where: { id: Number(id) },
    include: { actions: { orderBy: { sortOrder: "asc" } } },
  });
  return job || null;
}

export async function listJobs() {
  const jobs = await prisma.scheduled_jobs.findMany({
    include: { actions: { orderBy: { sortOrder: "asc" } }, runs: { orderBy: { id: "desc" }, take: 1 } },
    orderBy: { id: "desc" },
  });
  return jobs.map((j) => ({ ...j, lastRun: j.runs[0] || null }));
}

export async function setJobEnabled(id, enabled) {
  const job = await prisma.scheduled_jobs.findUnique({ where: { id: Number(id) } });
  if (!job) return;
  const now = new Date();
  const nextRunAt = enabled ? computeNextRunAt(job, now) : null;
  await prisma.scheduled_jobs.update({ where: { id: Number(id) }, data: { enabled: !!enabled, nextRunAt, updatedAt: now } });
}

export async function deleteJob(id) {
  await prisma.scheduled_jobs.delete({ where: { id: Number(id) } });
}

export async function duplicateJob(id, createdBy = null) {
  const job = await getJob(id);
  if (!job) throw new Error(`Job ${id} not found.`);
  return createJob(
    {
      title: `${job.title} (copy)`,
      description: job.description,
      enabled: false,
      scheduleType: job.scheduleType,
      runAt: job.runAt,
      frequency: job.frequency,
      recurInterval: job.recurInterval,
      byWeekday: job.byWeekday,
      byMonthDay: job.byMonthDay,
      timeOfDay: job.timeOfDay,
      timezone: job.timezone,
      untilDate: job.untilDate,
      runNumberStart: job.runNumberStart,
      actions: job.actions.map((a) => ({ actionType: a.actionType, payload: a.payload, continueOnError: a.continueOnError, sortOrder: a.sortOrder })),
    },
    createdBy
  );
}

export async function listRuns({ jobId, limit = 50 } = {}) {
  return prisma.scheduled_job_runs.findMany({
    where: jobId ? { jobId: Number(jobId) } : undefined,
    orderBy: { id: "desc" },
    take: Math.min(200, Number(limit) || 50),
  });
}

/** The next `count` occurrences for an unsaved or saved job (UI preview). */
export function previewOccurrences(jobLike, count = 5) {
  return upcoming({ ...jobLike, createdAt: jobLike.createdAt || new Date() }, count);
}

/** Action previews (preview() per action) for the job editor. */
export function previewActions(job) {
  return (job.actions || []).map((a) => {
    const mod = getActionModule(a.actionType);
    return { actionType: a.actionType, continueOnError: a.continueOnError, preview: mod ? mod.preview(a.payload || {}) : null };
  });
}
