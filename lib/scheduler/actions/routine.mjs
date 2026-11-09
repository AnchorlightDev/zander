/**
 * routine action: queue a saved routine's steps the way the bridge does.
 * payload: { routineSlug }
 */
import { queueRoutineTasks } from "../executor.mjs";

export function validate(payload = {}) {
  const errors = [];
  if (!payload.routineSlug || !String(payload.routineSlug).trim()) errors.push("routine: a routineSlug is required.");
  return errors;
}

export function describe(payload = {}) {
  return `Queue routine "${payload.routineSlug}"`;
}

export function preview(payload = {}) {
  return { summary: describe(payload), sideEffects: ["Queues every step of the routine for the addon to run."] };
}

export async function run(payload = {}) {
  const ids = await queueRoutineTasks(payload.routineSlug, { priority: Number(payload.priority) || 0 });
  return { status: "queued", message: `Queued ${ids.length} routine step(s)`, refs: { executorTaskIds: ids } };
}
