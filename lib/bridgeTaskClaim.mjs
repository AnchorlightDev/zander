/**
 * Claim pending executor tasks one row at a time and return only the tasks
 * this caller actually won. `tryClaim(id)` must run a conditional update
 * (`... SET status = 'processing' WHERE executorTaskId = ? AND status = 'pending'`)
 * and resolve to its affectedRows, so two servers polling the same 'any' task
 * can never both receive it. Tasks that were not pending are passed through
 * untouched (a poll for another status with claim=true claims nothing).
 *
 * @param {Array<{executorTaskId: number, status: string}>} tasks
 * @param {(id: number) => Promise<number>} tryClaim
 * @param {Date} [now]
 */
export async function claimPendingTasks(tasks, tryClaim, now = new Date()) {
  const claimed = [];
  for (const task of tasks) {
    if (task.status !== "pending") {
      claimed.push(task);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const affected = Number(await tryClaim(task.executorTaskId)) || 0;
    if (affected > 0) {
      claimed.push({ ...task, status: "processing", updatedAt: now });
    }
  }
  return claimed;
}
