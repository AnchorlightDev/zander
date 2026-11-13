/**
 * lib/forums/forumBridgeSync.mjs
 *
 * Website -> Discord half of the forum bridge.
 *
 *   forumController / forumReactionController emit forum events
 *     -> this module turns them into outbox rows (planOutboxTasks)
 *     -> the outbox processor performs them against Discord, retrying with
 *        backoff, so a Discord outage or rate limit loses nothing.
 *
 * Website posts appear in Discord through a webhook per bridged channel, under
 * the player's Minecraft name and head. Discord ids are written back onto the
 * discussion / post so later edits, deletes and reactions find their target.
 *
 * Everything is gated on features.discord.forumBridge at run time.
 */

import { createRequire } from "module";
import { ChannelFlags, ChannelType } from "discord.js";
import {
  completeOutboxTask,
  enqueueOutboxTask,
  failOutboxTask,
  getBridgeByCategoryId,
  getDiscussionForSync,
  getDueOutboxTasks,
  getPostForSync,
  listBridges,
  pruneOutbox,
  setBridgeWebhook,
  setDiscussionDiscordIds,
  setPostDiscordMessageId,
  touchBridgeSynced,
} from "../../controllers/forumBridgeController.js";
import { countWebReactions } from "../../controllers/forumReactionController.js";
import { FORUM_EVENTS, forumEvents } from "./forumEvents.mjs";
import {
  OUTBOX_ACTIONS,
  avatarUrlFor,
  formatWebPostForDiscord,
  planOutboxTasks,
  toThreadName,
  toWebhookUsername,
} from "./forumBridgeLogic.mjs";
import { discordReactIdentifier } from "./reactionEmoji.mjs";
import {
  cachedBridgeCount,
  cachedBridgeForCategory,
  cachedBridgeForChannel,
  invalidateBridgeCache,
  isBridgeCacheFresh,
  markSelfChange,
  setBridgeCache,
} from "./forumBridgeState.mjs";
import db from "../../controllers/databaseController.js";

const require = createRequire(import.meta.url);
const features = require("../config/features.cjs");

const WEBHOOK_NAME = "Zander Forum Bridge";
const NOT_FOUND_CODES = new Set([10003, 10008, 10015]); // unknown channel / message / webhook

export function isForumBridgeEnabled() {
  return Boolean(features.discord?.forumBridge);
}

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}

async function getClient() {
  const { client } = await import("../../controllers/discordController.js");
  return client;
}

function siteBase() {
  return String(process.env.siteAddress || "").trim().replace(/\/$/, "");
}

export function discussionUrl(discussionId, slug) {
  return `${siteBase()}/forums/discussion/${discussionId}${slug ? `/${slug}` : ""}`;
}

function isNotFound(error) {
  return NOT_FOUND_CODES.has(Number(error?.code)) || Number(error?.status) === 404;
}

// --------------------------------------------------------------------------
// Bridge cache
// --------------------------------------------------------------------------

export async function refreshBridgeCache() {
  const bridges = await listBridges({ enabledOnly: true });
  setBridgeCache(bridges);
  return bridges;
}

async function ensureBridgeCache() {
  if (!isBridgeCacheFresh()) await refreshBridgeCache();
}

export async function bridgeForCategory(categoryId) {
  await ensureBridgeCache();
  return cachedBridgeForCategory(categoryId);
}

export async function bridgeForChannel(channelId) {
  await ensureBridgeCache();
  return cachedBridgeForChannel(channelId);
}

export { invalidateBridgeCache };

// --------------------------------------------------------------------------
// Event subscription -> outbox
// --------------------------------------------------------------------------

async function categoryForDiscussion(discussionId) {
  if (!discussionId) return null;
  const [row] = await query(`SELECT categoryId FROM forumDiscussions WHERE discussionId = ? LIMIT 1`, [discussionId]);
  return row ? row.categoryId : null;
}

async function discussionForPost(postId) {
  if (!postId) return null;
  const [row] = await query(
    `SELECT p.discussionId, d.categoryId, d.discordThreadId
       FROM forumPosts p JOIN forumDiscussions d ON d.discussionId = p.discussionId
      WHERE p.postId = ? LIMIT 1`,
    [postId]
  );
  return row || null;
}

/** Is a Discord post for this discussion created or on its way? */
async function discussionHasThread(discussionId) {
  const [row] = await query(
    `SELECT d.discordThreadId,
            (SELECT COUNT(*) FROM forumSyncOutbox o
              WHERE o.discussionId = d.discussionId AND o.action = ? AND o.status = 'pending') AS pendingCreate
       FROM forumDiscussions d
      WHERE d.discussionId = ? LIMIT 1`,
    [OUTBOX_ACTIONS.CREATE_THREAD, discussionId]
  );
  return Boolean(row && (row.discordThreadId || Number(row.pendingCreate) > 0));
}

async function handleForumEvent(name, event) {
  if (!isForumBridgeEnabled()) return;
  await ensureBridgeCache();
  // Deleting a bridged discussion must still reach Discord after its category
  // was un-bridged, so only skip when nothing is bridged and nothing points at Discord.
  if (!cachedBridgeCount() && !event.discordThreadId && !event.discordMessageId) return;

  const ctx = { isBridged: (categoryId) => Boolean(cachedBridgeForCategory(categoryId)) };

  if (name === FORUM_EVENTS.POST_CREATED || name === FORUM_EVENTS.POST_UPDATED || name === FORUM_EVENTS.POST_DELETED) {
    ctx.categoryId = await categoryForDiscussion(event.discussionId);
    // New content only: replies in a discussion that has no Discord post
    // (it predates the bridge) stay on the website.
    if (name !== FORUM_EVENTS.POST_DELETED && !(await discussionHasThread(event.discussionId))) return;
  } else if (name === FORUM_EVENTS.REACTION_CHANGED) {
    const info = await discussionForPost(event.postId);
    if (!info || !info.discordThreadId) return;
    ctx.categoryId = info.categoryId;
    ctx.discussionId = info.discussionId;
  } else if (name === FORUM_EVENTS.DISCUSSION_UPDATED || name === FORUM_EVENTS.DISCUSSION_FLAGS) {
    if (!(await discussionHasThread(event.discussionId))) return;
  }

  const tasks = planOutboxTasks(name, event, ctx);
  if (!tasks.length) return;
  for (const task of tasks) {
    await enqueueOutboxTask(task);
  }
  scheduleOutboxRun();
}

let subscribed = false;

/** Subscribe to forum events. Safe to call more than once. */
export function startForumBridgeSync() {
  if (subscribed) return;
  subscribed = true;
  for (const name of Object.values(FORUM_EVENTS)) {
    forumEvents.on(name, (event) => handleForumEvent(name, event));
  }
}

// --------------------------------------------------------------------------
// Discord helpers
// --------------------------------------------------------------------------

const webhookCache = new Map(); // webhookId -> Webhook

/**
 * The bridge's webhook on its forum channel, creating (or re-creating) it if
 * needed. The bot owns the webhook, so Discord returns its token to us and no
 * secret has to be stored.
 */
export async function ensureBridgeWebhook(bridge, { forceNew = false } = {}) {
  const client = await getClient();
  if (!forceNew && bridge.webhookId) {
    const cached = webhookCache.get(bridge.webhookId);
    if (cached) return cached;
    try {
      const existing = await client.fetchWebhook(bridge.webhookId);
      if (existing?.token) {
        webhookCache.set(existing.id, existing);
        return existing;
      }
      // Without a token it can't be posted through; replace it rather than
      // leaving an unusable webhook on the channel.
      if (existing) await existing.delete("Forum bridge: replacing webhook").catch(() => {});
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  const channel = await client.channels.fetch(bridge.channelId);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    throw new Error(`Bridged channel ${bridge.channelId} is not a forum channel`);
  }
  const created = await channel.createWebhook({ name: WEBHOOK_NAME, reason: "Forum bridge" });
  webhookCache.set(created.id, created);
  if (bridge.webhookId) webhookCache.delete(bridge.webhookId);
  await setBridgeWebhook(bridge.bridgeId, created.id);
  bridge.webhookId = created.id;
  invalidateBridgeCache();
  return created;
}

/** Run a webhook call, re-creating the webhook once if Discord lost it. */
async function withWebhook(bridge, fn) {
  let webhook = await ensureBridgeWebhook(bridge);
  try {
    return await fn(webhook);
  } catch (error) {
    if (Number(error?.code) !== 10015) throw error;
    webhook = await ensureBridgeWebhook(bridge, { forceNew: true });
    return fn(webhook);
  }
}

async function fetchThread(threadId) {
  const client = await getClient();
  try {
    return await client.channels.fetch(threadId);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function bridgeFor(categoryId) {
  return getBridgeByCategoryId(categoryId);
}

async function requiredTags(bridge) {
  const client = await getClient();
  const forum = await client.channels.fetch(bridge.channelId).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return undefined;
  const requiresTag = forum.flags?.has?.(ChannelFlags.RequireTag);
  if (!requiresTag || !forum.availableTags?.length) return undefined;
  // A forum that demands a tag rejects untagged posts; use its first tag.
  return [forum.availableTags[0].id];
}

const NO_PINGS = { parse: [] };

/**
 * Save Discord ids after a send, retrying briefly. If the write is lost the
 * task is retried and would send to Discord a second time, so `undo` removes
 * what was just sent before the error propagates.
 */
async function writeBackOrUndo(write, undo, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await write();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  await Promise.resolve()
    .then(undo)
    .catch((error) => console.error("[forumBridge] Could not undo a Discord send after a failed write-back:", error?.message || error));
  throw lastError;
}

/**
 * Run `fn` with the thread open: Discord refuses edits and reactions in an
 * archived thread (error 50083). An auto-archived post is reopened and put
 * back afterwards; one the bridge closed (locked and archived) is left alone
 * and `fn` is skipped.
 */
async function withThreadOpen(thread, reason, fn) {
  if (!thread.archived) return fn();
  if (thread.locked) return undefined;
  await thread.setArchived(false, reason);
  try {
    return await fn();
  } finally {
    await thread.setArchived(true, reason).catch(() => {});
  }
}

// --------------------------------------------------------------------------
// Outbox actions
// --------------------------------------------------------------------------

async function createThread(task) {
  const d = await getDiscussionForSync(task.discussionId);
  if (!d || d.status !== "published" || d.discordThreadId || d.source === "discord") return;
  const bridge = await bridgeFor(d.categoryId);
  if (!bridge) return;

  const url = discussionUrl(d.discussionId, d.slug);
  const content = formatWebPostForDiscord(d.content, { postUrl: url });
  const appliedTags = await requiredTags(bridge);

  const message = await withWebhook(bridge, (webhook) =>
    webhook.send({
      threadName: toThreadName(d.title),
      content,
      username: toWebhookUsername(d.username),
      avatarURL: avatarUrlFor(d.uuid),
      allowedMentions: NO_PINGS,
      ...(appliedTags ? { appliedTags } : {}),
    })
  );

  const threadId = message.channelId || message.channel_id;
  await writeBackOrUndo(
    () => setDiscussionDiscordIds(d.discussionId, { threadId, starterMessageId: message.id }),
    async () => {
      const thread = await fetchThread(threadId);
      if (!thread) return;
      // In case the write did land, stop threadDelete archiving the discussion.
      markSelfChange(thread.id, { deleted: true });
      await thread.delete("Forum bridge: could not record this post, it will be re-created");
      await setDiscussionDiscordIds(d.discussionId, { threadId: null, starterMessageId: null }).catch(() => {});
      if (d.postId) await setPostDiscordMessageId(d.postId, null).catch(() => {});
    }
  );
  await touchBridgeSynced(bridge.bridgeId);

  if (d.isLocked || d.isArchived) {
    await setThreadState({ discussionId: d.discussionId });
  }
}

async function editStarter(task) {
  const d = await getDiscussionForSync(task.discussionId);
  if (!d || !d.discordThreadId || !d.discordStarterMessageId) return;
  // A Discord member's own message can only be edited by them, in Discord.
  if (d.source === "discord") return;
  const bridge = await bridgeFor(d.categoryId);
  if (!bridge) return;
  const content = formatWebPostForDiscord(d.content, { postUrl: discussionUrl(d.discussionId, d.slug) });
  const thread = await fetchThread(d.discordThreadId);
  if (!thread) return;
  try {
    await withThreadOpen(thread, "Edited on website", () =>
      withWebhook(bridge, (webhook) =>
        webhook.editMessage(d.discordStarterMessageId, { content, threadId: d.discordThreadId, allowedMentions: NO_PINGS })
      )
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function renameThread(task) {
  const d = await getDiscussionForSync(task.discussionId);
  if (!d || !d.discordThreadId) return;
  const thread = await fetchThread(d.discordThreadId);
  if (!thread) return;
  const name = toThreadName(d.title);
  if (thread.name === name) return;
  markSelfChange(thread.id, { name });
  const wasArchived = thread.archived;
  if (wasArchived) await thread.setArchived(false, "Renamed on website");
  await thread.setName(name, "Renamed on website");
  if (wasArchived) await thread.setArchived(true, "Renamed on website");
}

async function setThreadState(task) {
  const d = await getDiscussionForSync(task.discussionId);
  if (!d || !d.discordThreadId) return;
  const thread = await fetchThread(d.discordThreadId);
  if (!thread) return;
  // Apply the discussion's current flags, not the payload: a retried older
  // task must not undo a newer lock/unlock that already reached Discord.
  const isArchived = Boolean(d.isArchived);
  const isLocked = Boolean(d.isLocked);

  if (isArchived) {
    if (thread.archived && thread.locked) return;
    // An auto-archived post must be reopened to post the notice and lock it.
    if (thread.archived) await thread.setArchived(false, "Archived on website");
    await thread
      .send({
        content: `📦 This discussion has been archived on the website, so this post is now closed.\n<${discussionUrl(d.discussionId, d.slug)}>`,
        allowedMentions: NO_PINGS,
      })
      .catch(() => {});
    if (!thread.locked) {
      markSelfChange(thread.id, { locked: true });
      await thread.setLocked(true, "Archived on website");
    }
    await thread.setArchived(true, "Archived on website");
    return;
  }

  if (thread.archived) await thread.setArchived(false, "Unarchived on website");
  if (thread.locked !== isLocked) {
    markSelfChange(thread.id, { locked: isLocked });
    await thread.setLocked(isLocked, isLocked ? "Locked on website" : "Unlocked on website");
  }
}

async function deleteThread(task) {
  const threadId = task.payload?.threadId;
  if (!threadId) return;
  const thread = await fetchThread(threadId);
  if (!thread) return;
  try {
    await thread.delete("Discussion deleted on website");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function closeMovedThread(task) {
  const threadId = task.payload?.threadId;
  const thread = threadId ? await fetchThread(threadId) : null;
  if (!thread) return;
  // moveDiscussion has already unmapped the discussion from this post, so
  // nothing here is mirrored back onto the moved discussion.
  const d = await getDiscussionForSync(task.discussionId);
  if (thread.archived) await thread.setArchived(false, "Moved on website");
  await thread
    .send({
      content: `➡️ This discussion has moved to another part of the website forums and continues there:\n<${d ? discussionUrl(d.discussionId, d.slug) : siteBase()}>`,
      allowedMentions: NO_PINGS,
    })
    .catch(() => {});
  await thread.setLocked(true, "Moved on website");
  await thread.setArchived(true, "Moved on website");
}

async function createMessage(task) {
  const p = await getPostForSync(task.postId);
  if (!p || p.isOriginal || p.discordMessageId || p.source === "discord" || p.status !== "published") return;
  if (!p.discordThreadId) {
    // The Discord post is still being created; retry shortly.
    const pending = await query(
      `SELECT COUNT(*) AS total FROM forumSyncOutbox WHERE discussionId = ? AND action = ? AND status = 'pending'`,
      [p.discussionId, OUTBOX_ACTIONS.CREATE_THREAD]
    );
    if (Number(pending[0]?.total || 0) > 0) throw new Error("Discord post not created yet");
    return;
  }
  const bridge = await bridgeFor(p.categoryId);
  if (!bridge) return;

  const url = `${discussionUrl(p.discussionId, p.slug)}#post-${p.postId}`;
  let replyToUrl = null;
  if (p.replyToPostId) {
    replyToUrl = p.replyToDiscordMessageId
      ? `https://discord.com/channels/${bridge.guildId}/${p.discordThreadId}/${p.replyToDiscordMessageId}`
      : `${discussionUrl(p.discussionId, p.slug)}#post-${p.replyToPostId}`;
  }
  const content = formatWebPostForDiscord(p.content, {
    postUrl: url,
    replyToUsername: p.replyToPostId ? p.replyToUsername || "a post" : null,
    replyToUrl,
  });

  const thread = await fetchThread(p.discordThreadId);
  if (!thread) return;
  if (thread.archived && !thread.locked) {
    await thread.setArchived(false, "New reply on website");
  }

  const message = await withWebhook(bridge, (webhook) =>
    webhook.send({
      threadId: p.discordThreadId,
      content,
      username: toWebhookUsername(p.username),
      avatarURL: avatarUrlFor(p.uuid),
      allowedMentions: NO_PINGS,
    })
  );
  await writeBackOrUndo(
    () => setPostDiscordMessageId(p.postId, message.id),
    async () => {
      // Clear the id first: if the write did land, the messageDelete this
      // causes would otherwise find the post and delete it on the website.
      await setPostDiscordMessageId(p.postId, null);
      await withWebhook(bridge, (webhook) => webhook.deleteMessage(message.id, p.discordThreadId));
    }
  );
}

async function editMessage(task) {
  const p = await getPostForSync(task.postId);
  if (!p || !p.discordMessageId || !p.discordThreadId || p.source === "discord") return;
  const bridge = await bridgeFor(p.categoryId);
  if (!bridge) return;
  const content = formatWebPostForDiscord(p.content, {
    postUrl: `${discussionUrl(p.discussionId, p.slug)}#post-${p.postId}`,
    replyToUsername: p.replyToPostId ? p.replyToUsername || "a post" : null,
    replyToUrl: p.replyToPostId && p.replyToDiscordMessageId
      ? `https://discord.com/channels/${bridge.guildId}/${p.discordThreadId}/${p.replyToDiscordMessageId}`
      : null,
  });
  const thread = await fetchThread(p.discordThreadId);
  if (!thread) return;
  try {
    await withThreadOpen(thread, "Edited on website", () =>
      withWebhook(bridge, (webhook) =>
        webhook.editMessage(p.discordMessageId, { content, threadId: p.discordThreadId, allowedMentions: NO_PINGS })
      )
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function deleteMessage(task) {
  const messageId = task.payload?.messageId;
  if (!messageId || !task.discussionId) return;
  const d = await getDiscussionForSync(task.discussionId);
  if (!d || !d.discordThreadId) return;
  const thread = await fetchThread(d.discordThreadId);
  if (!thread) return;
  try {
    await thread.messages.delete(messageId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function syncReaction(task) {
  const emoji = task.payload?.emoji;
  const identifier = discordReactIdentifier(emoji);
  if (!identifier) return;
  const p = await getPostForSync(task.postId);
  if (!p || !p.discordMessageId || !p.discordThreadId) return;
  const thread = await fetchThread(p.discordThreadId);
  if (!thread) return;

  let message;
  try {
    message = await thread.messages.fetch(p.discordMessageId);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  const client = await getClient();
  const webCount = await countWebReactions(p.postId, emoji);
  const reaction = message.reactions.resolve(identifier);
  const botReacted = Boolean(reaction?.me);

  // A bot cannot react on someone's behalf, so website reactions show in
  // Discord as one reaction from the bot per emoji in use.
  if (webCount > 0 && !botReacted) {
    await withThreadOpen(thread, "Reaction on website", () => message.react(identifier));
  } else if (webCount === 0 && botReacted) {
    await withThreadOpen(thread, "Reaction on website", () => reaction.users.remove(client.user.id));
  }
}

const HANDLERS = {
  [OUTBOX_ACTIONS.CREATE_THREAD]: createThread,
  [OUTBOX_ACTIONS.EDIT_STARTER]: editStarter,
  [OUTBOX_ACTIONS.RENAME_THREAD]: renameThread,
  [OUTBOX_ACTIONS.SET_THREAD_STATE]: setThreadState,
  [OUTBOX_ACTIONS.DELETE_THREAD]: deleteThread,
  [OUTBOX_ACTIONS.CLOSE_MOVED_THREAD]: closeMovedThread,
  [OUTBOX_ACTIONS.CREATE_MESSAGE]: createMessage,
  [OUTBOX_ACTIONS.EDIT_MESSAGE]: editMessage,
  [OUTBOX_ACTIONS.DELETE_MESSAGE]: deleteMessage,
  [OUTBOX_ACTIONS.SYNC_REACTION]: syncReaction,
};

// --------------------------------------------------------------------------
// Processor
// --------------------------------------------------------------------------

let running = false;
let rerunRequested = false;
let scheduled = null;

/** Run the outbox soon (debounced), e.g. right after a forum write. */
export function scheduleOutboxRun(delayMs = 250) {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    processForumOutbox().catch((error) => console.error("[forumBridge] Outbox run failed:", error));
  }, delayMs);
  scheduled.unref?.();
}

/** Perform every due outbox task, oldest first. */
export async function processForumOutbox() {
  if (!isForumBridgeEnabled()) return { processed: 0 };
  if (running) {
    rerunRequested = true;
    return { processed: 0 };
  }
  const client = await getClient();
  if (!client?.isReady?.()) return { processed: 0 };

  running = true;
  let processed = 0;
  try {
    do {
      rerunRequested = false;
      const tasks = await getDueOutboxTasks(25);
      for (const task of tasks) {
        const handler = HANDLERS[task.action];
        try {
          if (handler) await handler(task);
          await completeOutboxTask(task.taskId);
        } catch (error) {
          const gaveUp = await failOutboxTask(task.taskId, task.attempts, error?.message || String(error));
          const label = `[forumBridge] ${task.action} #${task.taskId}`;
          if (gaveUp) console.error(`${label} failed permanently:`, error);
          else console.warn(`${label} failed, will retry:`, error?.message || error);
        }
        processed += 1;
      }
      if (tasks.length === 25) rerunRequested = true;
    } while (rerunRequested);
  } finally {
    running = false;
  }
  return { processed };
}

export async function pruneForumOutbox() {
  await pruneOutbox();
}
