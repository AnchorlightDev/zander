/**
 * lib/scheduler/actions/index.mjs
 *
 * Registry of scheduler action types. Each module exports validate/describe/
 * preview/run. The runner, dashboard and MCP tools resolve action types here.
 */
import * as command from "./command.mjs";
import * as routine from "./routine.mjs";
import * as discord_message from "./discord_message.mjs";
import * as forum_publish from "./forum_publish.mjs";
import * as announcement_post from "./announcement_post.mjs";
import * as broadcast from "./broadcast.mjs";

export const ACTION_MODULES = {
  command,
  routine,
  discord_message,
  forum_publish,
  announcement_post,
  broadcast,
};

export const ACTION_TYPES = Object.keys(ACTION_MODULES);

export function getActionModule(actionType) {
  return ACTION_MODULES[actionType] || null;
}

/** Validate an action's payload (type + its own rules). Returns error strings. */
export function validateAction(actionType, payload = {}) {
  const mod = getActionModule(actionType);
  if (!mod) return [`Unknown action type "${actionType}".`];
  return mod.validate(payload) || [];
}
