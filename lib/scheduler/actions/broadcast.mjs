/**
 * broadcast action: an in-game network broadcast via the proxy /alert command.
 * payload: { message } (& colour codes)
 *
 * Delivery: the only command path the web app controls is the executor queue, so
 * this queues an `alert <message>` console command for the broadcast slug
 * (config.scheduler.broadcastSlug, default "proxy"). NOTE: the Velocity proxy does
 * not currently poll executor tasks - only backend servers do - so the broadcast
 * slug must point at a target that actually runs /alert network-wide. This gap is
 * reported in the release notes; no direct DB connection is made to the proxy.
 */
import { createRequire } from "module";
import { queueCommandTask } from "../executor.mjs";

// Read config.scheduler.broadcastSlug at use time (createRequire, since this is ESM).
const require = createRequire(import.meta.url);
const config = require("../../config/config.cjs");

export function validate(payload = {}) {
  const errors = [];
  if (!payload.message || !String(payload.message).trim()) errors.push("broadcast: a message is required.");
  return errors;
}

export function describe(payload = {}) {
  return `Broadcast in-game: "${payload.message}"`;
}

export function preview(payload = {}) {
  const slug = config.scheduler?.broadcastSlug || "proxy";
  return { summary: describe(payload), sideEffects: [`Queues "alert ${payload.message}" on "${slug}" (must reach the proxy).`] };
}

export async function run(payload = {}) {
  const slug = config.scheduler?.broadcastSlug || "proxy";
  const executorTaskId = await queueCommandTask({ slug, command: `alert ${payload.message}` });
  return { status: "queued", message: `Broadcast queued on "${slug}"`, refs: { executorTaskId } };
}
