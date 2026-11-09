/**
 * announcement_post action: enable or disable an announcement post.
 * payload: { postId, mode: 'enable' | 'disable' }
 * Sets enabled on every platform row of the post and invalidates the web cache
 * (setPostEnabled does both).
 */
import { setPostEnabled } from "../../../services/announcementPostService.js";

export function validate(payload = {}) {
  const errors = [];
  const id = Number(payload.postId);
  if (!Number.isInteger(id) || id <= 0) errors.push("announcement_post: a valid postId is required.");
  if (!["enable", "disable"].includes(payload.mode)) errors.push("announcement_post: mode must be 'enable' or 'disable'.");
  return errors;
}

export function describe(payload = {}) {
  return `${payload.mode === "enable" ? "Enable" : "Disable"} announcement post #${payload.postId}`;
}

export function preview(payload = {}) {
  return { summary: describe(payload), sideEffects: [`Sets enabled=${payload.mode === "enable"} on every platform of post #${payload.postId}.`] };
}

export async function run(payload = {}) {
  await setPostEnabled(Number(payload.postId), payload.mode === "enable");
  return { status: "succeeded", message: `${payload.mode}d announcement post #${payload.postId}`, refs: { postId: Number(payload.postId) } };
}
