/**
 * command action: run a console command on a server (or every server).
 * payload: { target: slug | 'any', command, executeAs: 'console' }
 * Completion is asynchronous (the addon polls the queue), so the run reports
 * "queued" with the executorTasks id.
 */
import { queueCommandTask, normalizeCommand } from "../executor.mjs";

export function validate(payload = {}) {
  const errors = [];
  if (!payload.target || !String(payload.target).trim()) errors.push("command: a target server slug (or 'any') is required.");
  if (!normalizeCommand(payload.command)) errors.push("command: a command is required.");
  if (payload.executeAs && payload.executeAs !== "console") errors.push("command: only executeAs 'console' is supported.");
  return errors;
}

export function describe(payload = {}) {
  const target = payload.target === "any" ? "every server" : payload.target;
  return `Run "/${normalizeCommand(payload.command)}" as console on ${target}`;
}

export function preview(payload = {}) {
  return { summary: describe(payload), sideEffects: ["Queues a console command for the addon to run."] };
}

export async function run(payload = {}) {
  const executorTaskId = await queueCommandTask({
    slug: payload.target,
    command: payload.command,
    priority: Number(payload.priority) || 0,
  });
  return { status: "queued", message: `Command queued on ${payload.target}`, refs: { executorTaskId } };
}
