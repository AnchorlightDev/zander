/**
 * forum_publish action: publish a draft or scheduled forum thread.
 * payload: { discussionId }
 * Fails clearly if the thread is not a draft or scheduled thread.
 */
import { prisma } from "../../../controllers/databaseController.js";
import { publishDiscussion } from "../../../controllers/forumController.js";

export function validate(payload = {}) {
  const errors = [];
  const id = Number(payload.discussionId);
  if (!Number.isInteger(id) || id <= 0) errors.push("forum_publish: a valid discussionId is required.");
  return errors;
}

export function describe(payload = {}) {
  return `Publish forum thread #${payload.discussionId}`;
}

export function preview(payload = {}) {
  return { summary: describe(payload), sideEffects: ["Publishes the thread, setting its createdAt/lastPostAt to now."] };
}

export async function run(payload = {}) {
  const id = Number(payload.discussionId);
  const row = await prisma.forumDiscussions.findUnique({ where: { discussionId: id }, select: { status: true } });
  if (!row) return { status: "failed", message: `Forum thread #${id} was not found.` };
  if (!["draft", "scheduled"].includes(row.status)) {
    return { status: "failed", message: `Forum thread #${id} is not a draft or scheduled thread (status: ${row.status}).` };
  }
  await publishDiscussion(id);
  return { status: "succeeded", message: `Published forum thread #${id}`, refs: { discussionId: id } };
}
