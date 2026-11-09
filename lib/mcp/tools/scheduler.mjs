/**
 * lib/mcp/tools/scheduler.mjs
 *
 * Scheduler tools, behind zander.web.scheduler. They call the job service
 * (services/schedulerJobService.mjs) in-process. There is deliberately NO
 * "run now" tool: running a job fires real side effects (server commands,
 * broadcasts, Discord posts) immediately, so that stays a human action in the
 * dashboard behind a confirm dialog, not something an assistant can trigger.
 */
import { ToolError } from "../protocol.mjs";
import { compact } from "./helpers.mjs";
import { generateLog } from "../../../api/common.js";
import {
  createJob,
  updateJob,
  getJob,
  listJobs,
  setJobEnabled,
  listRuns,
} from "../../../services/schedulerJobService.mjs";

const NODE = ["zander.web.scheduler"];

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    actionType: { type: "string", enum: ["command", "routine", "discord_message", "forum_publish", "announcement_post", "broadcast"] },
    payload: { type: "object", description: "The action's fields (see the action type)." },
    continueOnError: { type: "boolean", description: "Continue the run if this action fails (default false)." },
  },
  required: ["actionType", "payload"],
};

const JOB_FIELDS = {
  title: { type: "string" },
  description: { type: "string" },
  enabled: { type: "boolean" },
  scheduleType: { type: "string", enum: ["once", "recurring"] },
  runAt: { type: "string", description: "once: ISO 8601 UTC run time." },
  frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
  recurInterval: { type: "integer", minimum: 1 },
  byWeekday: { type: "string", description: "weekly: ISO weekdays 1=Mon..7=Sun, comma separated, e.g. '1,3,5'." },
  byMonthDay: { type: "integer", minimum: 1, maximum: 31 },
  timeOfDay: { type: "string", description: "recurring: HH:MM in the job timezone." },
  timezone: { type: "string", description: "IANA timezone (default Australia/Sydney)." },
  untilDate: { type: "string", description: "recurring: ISO 8601 cutoff (optional)." },
  runNumberStart: { type: "integer", minimum: 1, description: "Starting value for {runNumber} (default 1)." },
  actions: { type: "array", items: ACTION_SCHEMA },
};

function jobView(job) {
  return compact({
    id: job.id,
    title: job.title,
    description: job.description || undefined,
    enabled: job.enabled,
    scheduleType: job.scheduleType,
    runAt: job.runAt ? new Date(job.runAt).toISOString() : undefined,
    frequency: job.frequency || undefined,
    recurInterval: job.recurInterval,
    byWeekday: job.byWeekday || undefined,
    byMonthDay: job.byMonthDay || undefined,
    timeOfDay: job.timeOfDay || undefined,
    timezone: job.timezone,
    untilDate: job.untilDate ? new Date(job.untilDate).toISOString() : undefined,
    runNumberStart: job.runNumberStart,
    nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : undefined,
    actions: (job.actions || []).map((a) => ({ actionType: a.actionType, payload: a.payload, continueOnError: a.continueOnError })),
    lastRun: job.lastRun ? { status: job.lastRun.status, dueAt: new Date(job.lastRun.dueAt).toISOString() } : undefined,
  });
}

function asToolError(error) {
  if (error?.errors) return new ToolError(error.errors.join(" "));
  return error instanceof ToolError ? error : new ToolError(error?.message || String(error));
}

export const schedulerTools = [
  {
    name: "scheduler_list_jobs",
    title: "List scheduled jobs",
    permission: NODE,
    description: "List scheduled jobs with their actions, next run and last run status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async handler(_args, _ctx) {
      return (await listJobs()).map(jobView);
    },
  },
  {
    name: "scheduler_get_job",
    title: "Get a scheduled job",
    permission: NODE,
    description: "Fetch one scheduled job by id, with its ordered actions.",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"] },
    annotations: { readOnlyHint: true },
    async handler({ id }, _ctx) {
      const job = await getJob(id);
      if (!job) throw new ToolError(`Job ${id} not found.`);
      return jobView(job);
    },
  },
  {
    name: "scheduler_create_job",
    title: "Create a scheduled job",
    permission: NODE,
    description: "Create a scheduled job. A recurring job needs a frequency and time; a once job needs runAt. Add at least one action.",
    inputSchema: { type: "object", properties: JOB_FIELDS, required: ["title", "scheduleType", "actions"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args, ctx) {
      try {
        const id = await createJob(args, ctx.user.userId);
        await generateLog(ctx.user.userId, "SUCCESS", "SCHEDULER", `Created job ${id} (MCP)`).catch(() => {});
        return { message: "Job created.", job: jobView(await getJob(id)) };
      } catch (e) {
        throw asToolError(e);
      }
    },
  },
  {
    name: "scheduler_update_job",
    title: "Update a scheduled job",
    permission: NODE,
    description: "Replace a scheduled job's fields and actions (the actions you pass become the full set).",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, ...JOB_FIELDS }, required: ["id", "title", "scheduleType", "actions"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args, ctx) {
      const existing = await getJob(args.id);
      if (!existing) throw new ToolError(`Job ${args.id} not found.`);
      try {
        await updateJob(args.id, args, ctx.user.userId);
        await generateLog(ctx.user.userId, "SUCCESS", "SCHEDULER", `Edited job ${args.id} (MCP)`).catch(() => {});
        return { message: "Job updated.", job: jobView(await getJob(args.id)) };
      } catch (e) {
        throw asToolError(e);
      }
    },
  },
  {
    name: "scheduler_set_enabled",
    title: "Enable or disable a job",
    permission: NODE,
    description: "Enable or disable a scheduled job. Enabling recomputes its next run.",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 }, enabled: { type: "boolean" } }, required: ["id", "enabled"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler({ id, enabled }, ctx) {
      const job = await getJob(id);
      if (!job) throw new ToolError(`Job ${id} not found.`);
      await setJobEnabled(id, enabled);
      await generateLog(ctx.user.userId, "SUCCESS", "SCHEDULER", `${enabled ? "Enabled" : "Disabled"} job ${id} (MCP)`).catch(() => {});
      return { message: `Job ${enabled ? "enabled" : "disabled"}.` };
    },
  },
  {
    name: "scheduler_list_runs",
    title: "List job runs",
    permission: NODE,
    description: "List recent runs, optionally for one job, with per-action results.",
    inputSchema: { type: "object", properties: { jobId: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
    annotations: { readOnlyHint: true },
    async handler({ jobId, limit }, _ctx) {
      const runs = await listRuns({ jobId, limit });
      return runs.map((r) => compact({
        id: r.id,
        jobId: r.jobId,
        dueAt: new Date(r.dueAt).toISOString(),
        status: r.status,
        trigger: r.triggerType,
        runNumber: r.runNumber == null ? undefined : r.runNumber,
        results: r.results || undefined,
      }));
    },
  },
];
