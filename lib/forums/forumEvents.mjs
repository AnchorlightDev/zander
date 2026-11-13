/**
 * lib/forums/forumEvents.mjs
 *
 * In-process event bus for forum changes. forumController emits here after
 * every write; the Discord forum bridge (lib/forums/forumBridgeSync.mjs)
 * subscribes and queues the matching Discord action.
 *
 * Every event carries `origin` ("web" or "discord"). Changes that came FROM
 * Discord are emitted with origin "discord" so the bridge does not echo them
 * straight back -- that is the loop guard.
 *
 * Emitting never throws into the caller: a listener failure must not fail the
 * forum write that triggered it.
 *
 * Imports nothing app-specific, so it is unit-testable.
 */

import { EventEmitter } from "node:events";

export const FORUM_EVENTS = Object.freeze({
  DISCUSSION_CREATED: "discussion.created",
  DISCUSSION_UPDATED: "discussion.updated",
  DISCUSSION_DELETED: "discussion.deleted",
  DISCUSSION_MOVED: "discussion.moved",
  DISCUSSION_FLAGS: "discussion.flags",
  POST_CREATED: "post.created",
  POST_UPDATED: "post.updated",
  POST_DELETED: "post.deleted",
  REACTION_CHANGED: "reaction.changed",
});

export const ORIGIN = Object.freeze({ WEB: "web", DISCORD: "discord" });

export const forumEvents = new EventEmitter();
// Several modules may subscribe (bridge, tests); never warn about that.
forumEvents.setMaxListeners(50);

/**
 * Emit a forum event without letting a listener error escape.
 * @param {string} name one of FORUM_EVENTS
 * @param {object} payload must include `origin`
 */
export function emitForumEvent(name, payload = {}) {
  const event = { origin: ORIGIN.WEB, ...payload };
  for (const listener of forumEvents.listeners(name)) {
    try {
      const result = listener(event);
      if (result && typeof result.catch === "function") {
        result.catch((error) => console.error(`[forumEvents] ${name} listener failed:`, error));
      }
    } catch (error) {
      console.error(`[forumEvents] ${name} listener failed:`, error);
    }
  }
}
