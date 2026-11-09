/**
 * lib/scheduler/executor.mjs
 *
 * The scheduler's one path to the server-command queue. It inserts the same
 * `executorTasks` rows the bridge inserts (api/routes/bridge.js) - same columns,
 * same 'pending' status, polled by the zander-addon on each backend server -
 * so there is only ever one command path, not two.
 */
import db from "../../controllers/databaseController.js";

function q(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results)));
  });
}

/** Strip leading slashes, matching the bridge's normalizeCommand. */
export function normalizeCommand(command) {
  return String(command ?? "").replace(/^\/+/, "").trim();
}

/** Queue one console command for a server slug (or 'any'); returns the task id. */
export async function queueCommandTask({ slug, command, metadata = null, priority = 0 }) {
  const resolved = normalizeCommand(command);
  if (!slug) throw new Error("A target slug is required.");
  if (!resolved) throw new Error("A command is required.");
  const result = await q(
    `INSERT INTO executorTasks (slug, command, status, routineSlug, metadata, priority) VALUES (?, ?, 'pending', ?, ?, ?)`,
    [slug, resolved, null, metadata ? JSON.stringify(metadata) : null, Number(priority) || 0]
  );
  return result.insertId;
}

/** Queue every step of a routine (same expansion the bridge does); returns task ids. */
export async function queueRoutineTasks(routineSlug, { priority = 0 } = {}) {
  if (!routineSlug) throw new Error("A routineSlug is required.");
  const routines = await q(`SELECT executorRoutineId FROM executorRoutines WHERE routineSlug = ?`, [routineSlug]);
  if (!routines.length) throw new Error(`Routine '${routineSlug}' could not be found.`);
  const steps = await q(
    `SELECT slug, command, metadata FROM executorRoutineSteps WHERE executorRoutineId = ? ORDER BY stepOrder ASC`,
    [routines[0].executorRoutineId]
  );
  if (!steps.length) throw new Error(`Routine '${routineSlug}' has no steps.`);

  const ids = [];
  for (const step of steps) {
    const resolved = normalizeCommand(step.command);
    if (!resolved) continue;
    const result = await q(
      `INSERT INTO executorTasks (slug, command, status, routineSlug, metadata, priority) VALUES (?, ?, 'pending', ?, ?, ?)`,
      [step.slug, resolved, routineSlug, step.metadata || null, Number(priority) || 0]
    );
    ids.push(result.insertId);
  }
  return ids;
}
