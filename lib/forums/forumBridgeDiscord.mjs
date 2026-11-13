/**
 * lib/forums/forumBridgeDiscord.mjs
 *
 * Discord -> website half of the forum bridge. The listeners in listeners/
 * forumBridge*.js are thin wrappers around these handlers.
 *
 *   New forum post in a bridged channel -> new website discussion
 *   Message in that post                -> reply (Discord replies keep their target)
 *   Edit                                -> post edit, with revision history
 *   Message deleted                     -> reply deleted
 *   Forum post (or its first message)   -> discussion ARCHIVED, never deleted
 *   Post renamed / locked               -> discussion renamed / locked
 *   Reaction added / removed            -> website reaction added / removed
 *
 * Only members whose Discord is linked to a real, enabled website account may
 * post or react. Anything from anyone else is removed and they are DMed how to
 * link. The channel's Linked-role permissions normally stop it first.
 *
 * Changes are written with origin "discord" so the outbound half never echoes
 * them back.
 */

import fetch from "node-fetch";
import {
  getDiscussionByThreadId,
  getLinkedUserByDiscordId,
  getPostByDiscordMessageId,
  setDiscussionDiscordIds,
} from "../../controllers/forumBridgeController.js";
import {
  createDiscussion,
  createReply,
  deletePost,
  permissionMatch,
  setDiscussionFlags,
  updateDiscussion,
  updatePost,
} from "../../controllers/forumController.js";
import {
  addReaction,
  removeDiscordReactions,
  removeReaction,
} from "../../controllers/forumReactionController.js";
import { getUserPermissions } from "../../controllers/userController.js";
import { hasActiveWebBan } from "../../controllers/discordPunishmentController.js";
import { isCloudinaryConfigured, uploadImage } from "../../services/cloudinaryService.js";
import { ORIGIN } from "./forumEvents.mjs";
import {
  attachmentsToHtml,
  bridgeCheckNeedsPermissions,
  bridgeParticipationRefusal,
  createDmThrottle,
  discordMarkdownToHtml,
  discordMessageContentChanged,
  isEffectivelyEmpty,
  reusableHostedUrls,
} from "./forumBridgeLogic.mjs";
import { emojiKeyFromDiscord } from "./reactionEmoji.mjs";
import { isSelfChange, markSelfChange, runSerial } from "./forumBridgeState.mjs";
import { bridgeForChannel, discussionUrl, isForumBridgeEnabled } from "./forumBridgeSync.mjs";
import { syncLinkedRoleForDiscordId } from "../discord/linkedRoleSync.mjs";

const MAX_REHOST_BYTES = 10 * 1024 * 1024;
const shouldDm = createDmThrottle();

function siteBase() {
  return String(process.env.siteAddress || "").trim().replace(/\/$/, "");
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** The bridge for a message/thread's parent forum channel, if any. */
async function bridgeForThread(channel) {
  if (!isForumBridgeEnabled()) return null;
  if (!channel?.isThread?.() || !channel.parentId) return null;
  return bridgeForChannel(channel.parentId);
}

async function dmMember(user, content) {
  if (!user || !shouldDm(user.id)) return;
  try {
    await user.send({ content, allowedMentions: { parse: [] } });
  } catch {
    // DMs closed: nothing else to do.
  }
}

function linkInstructions(channelName) {
  const base = siteBase();
  return [
    `To post or react in **#${channelName}** you need a Crafting For Christ website account with this Discord account linked.`,
    `1. Sign in at <${base}/login> (or create an account at <${base}/register>).`,
    `2. Link Discord at <${base}/profile/social/discord/connect>.`,
    `Once linked you can join in straight away, and everything you post here also appears on the website forums.`,
  ].join("\n");
}

/**
 * Can this Discord user take part? Returns the linked website user, or null
 * after removing nothing (the caller removes the content).
 */
async function resolveParticipant(discordUser) {
  const linked = await getLinkedUserByDiscordId(discordUser.id);
  if (!linked) return { user: null, reason: "unlinked" };
  if (await hasActiveWebBan(linked.userId)) return { user: null, reason: "banned" };
  return { user: linked, reason: null };
}

async function refuse(discordUser, channelName, reason) {
  if (reason === "unlinked") {
    await dmMember(discordUser, linkInstructions(channelName));
    // Self-heal: someone with the Linked role who is not linked loses it.
    syncLinkedRoleForDiscordId(discordUser.id).catch(() => {});
  } else if (reason === "banned") {
    await dmMember(discordUser, `You can't post or react in **#${channelName}** while you have an active website ban.`);
  } else if (reason === "permission") {
    await dmMember(discordUser, `You don't have permission to start new posts in **#${channelName}**. You can still reply to existing posts.`);
  } else if (reason === "view") {
    await dmMember(discordUser, `Your website account doesn't have access to the forum category behind **#${channelName}**, so you can't post or react there.`);
  } else if (reason === "closed") {
    await dmMember(discordUser, `That post in **#${channelName}** is locked or archived on the website, so new replies can't be added.`);
  }
}

/**
 * Website-side checks for a linked member (category view permission, post
 * permission for new posts, locked/archived discussions). Returns a refusal
 * reason or null.
 */
async function participationRefusal(user, bridge, action, discussion = null) {
  if (!bridgeCheckNeedsPermissions({ bridge, action, discussion })) return null;
  const permissions = await categoryPermissionsFor(user);
  return bridgeParticipationRefusal({ permissions, bridge, action, discussion, matches: permissionMatch });
}

/**
 * Re-host image attachments (Discord CDN links expire after about a day).
 * `reuse` holds URLs already hosted for this message (on an edit), which are
 * kept rather than uploaded again.
 */
async function rehostAttachments(attachments, reuse = new Map()) {
  const hosted = new Map(reuse);
  if (!isCloudinaryConfigured()) return hosted;
  for (const att of attachments) {
    if (hosted.has(att.id)) continue;
    const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(att.contentType || "");
    if (!isImage || (att.size || 0) > MAX_REHOST_BYTES) continue;
    try {
      const response = await fetch(att.url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      const uploaded = await uploadImage(buffer, { folder: "zander/forums" });
      const url = uploaded?.secure_url || uploaded?.url;
      if (url) hosted.set(att.id, url);
    } catch (error) {
      console.warn("[forumBridge] Could not re-host attachment:", error?.message || error);
    }
  }
  return hosted;
}

/** Discord message -> forum HTML. `storedHtml`: the post's current content, on an edit. */
async function messageToHtml(message, { storedHtml = null } = {}) {
  const guild = message.guild;
  const html = discordMarkdownToHtml(message.content || "", {
    resolveUser: (id) =>
      message.mentions?.members?.get(id)?.displayName ||
      message.mentions?.users?.get(id)?.globalName ||
      message.mentions?.users?.get(id)?.username ||
      guild?.members?.cache?.get(id)?.displayName ||
      null,
    resolveChannel: (id) => guild?.channels?.cache?.get(id)?.name || null,
    resolveRole: (id) => guild?.roles?.cache?.get(id)?.name || null,
  });

  const attachments = [...(message.attachments?.values?.() || [])].map((a) => ({
    id: a.id,
    name: a.name,
    url: a.url,
    contentType: a.contentType,
    size: a.size,
  }));
  const reuse = storedHtml ? reusableHostedUrls(storedHtml, attachments) : new Map();
  const hosted = attachments.length ? await rehostAttachments(attachments, reuse) : new Map();
  const attachmentHtml = attachmentsToHtml(attachments, hosted);

  const stickers = [...(message.stickers?.values?.() || [])].map((s) => `<p><em>[sticker: ${String(s.name).replace(/[<>&"]/g, "")}]</em></p>`).join("");

  const combined = `${html}${attachmentHtml}${stickers}`;
  return isEffectivelyEmpty(combined) ? "<p><em>(no text)</em></p>" : combined;
}

async function categoryPermissionsFor(user) {
  const perms = await getUserPermissions(user).catch(() => []);
  return [...(Array.isArray(perms) ? perms : []), "@authenticated"];
}

function isUserContent(message) {
  // 0 = Default, 19 = Reply. Everything else is a system notice.
  return message.type === 0 || message.type === 19;
}

// --------------------------------------------------------------------------
// Messages
// --------------------------------------------------------------------------

export async function handleMessageCreate(message) {
  const channel = message.channel;
  const bridge = await bridgeForThread(channel);
  if (!bridge) return;
  if (message.webhookId || message.author?.bot || message.system || !isUserContent(message)) return;

  await runSerial(channel.id, async () => {
    const isStarter = message.id === channel.id;
    const { user, reason } = await resolveParticipant(message.author);

    if (!user) {
      if (isStarter) {
        await channel.delete("Forum bridge: author has no linked website account").catch(() => {});
      } else {
        await message.delete().catch(() => {});
      }
      await refuse(message.author, channel.parent?.name || "forum", reason);
      return;
    }

    if (isStarter) {
      if (await getDiscussionByThreadId(channel.id)) return;
      const refusal = await participationRefusal(user, bridge, "start");
      if (refusal) {
        await channel.delete("Forum bridge: no permission to post in this category").catch(() => {});
        await refuse(message.author, channel.parent?.name || "forum", refusal);
        return;
      }

      const content = await messageToHtml(message);
      const discussion = await createDiscussion({
        categoryId: bridge.categoryId,
        userId: user.userId,
        title: String(channel.name || "Discussion").slice(0, 200),
        content,
        origin: ORIGIN.DISCORD,
        discordThreadId: channel.id,
        discordStarterMessageId: message.id,
      });

      if (discussion) {
        await channel
          .send({
            content: `🌐 This post is also on the website forums: <${discussionUrl(discussion.discussionId, discussion.slug)}>`,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
      return;
    }

    const discussion = await getDiscussionByThreadId(channel.id);
    if (!discussion) return; // post predates the bridge
    if (await getPostByDiscordMessageId(message.id)) return;

    // The same checks the website reply route makes: the category must be
    // visible to them, and a locked or archived discussion takes moderators only.
    const refusal = await participationRefusal(user, bridge, "reply", discussion);
    if (refusal) {
      await message.delete().catch(() => {});
      await refuse(message.author, channel.parent?.name || "forum", refusal);
      return;
    }

    let replyToPostId = null;
    const referenceId = message.reference?.messageId;
    if (referenceId) {
      const target = await getPostByDiscordMessageId(referenceId);
      if (target && target.discussionId === discussion.discussionId) replyToPostId = target.postId;
    }

    await createReply({
      discussionId: discussion.discussionId,
      userId: user.userId,
      content: await messageToHtml(message),
      replyToPostId,
      origin: ORIGIN.DISCORD,
      discordMessageId: message.id,
    });
  });
}

export async function handleMessageUpdate(oldMessage, newMessage) {
  if (!isForumBridgeEnabled()) return;
  let message = newMessage;
  if (message.partial) {
    message = await message.fetch().catch(() => null);
    if (!message) return;
  }
  const bridge = await bridgeForThread(message.channel);
  if (!bridge || message.webhookId || message.author?.bot) return;
  // Embed unfurls, pins and flag changes also arrive as updates.
  if (discordMessageContentChanged(oldMessage, message) === false) return;

  await runSerial(message.channel.id, async () => {
    const post = await getPostByDiscordMessageId(message.id);
    if (!post || post.source !== "discord") return;
    const content = await messageToHtml(message, { storedHtml: post.content });
    if (post.isOriginal) {
      await updateDiscussion(post.discussionId, { content, editorUserId: post.userId, origin: ORIGIN.DISCORD });
    } else {
      await updatePost(post.postId, { content, editorUserId: post.userId, origin: ORIGIN.DISCORD });
    }
  });
}

export async function handleMessageDelete(message) {
  if (!isForumBridgeEnabled() || !message?.id) return;
  const post = await getPostByDiscordMessageId(message.id);
  if (!post) return;

  const key = message.channelId || message.channel?.id || `post-${post.discussionId}`;
  await runSerial(key, async () => {
    if (post.isOriginal) {
      // Deleting a forum post's first message removes the post for readers:
      // archive the discussion rather than lose it.
      await setDiscussionFlags(post.discussionId, { isArchived: true }, { origin: ORIGIN.DISCORD });
      // Discord leaves the post itself open, and discord-origin changes never
      // reach the outbox, so close it here to match the archived discussion.
      const thread = message.channel?.isThread?.()
        ? message.channel
        : await message.client?.channels?.fetch(message.channelId).catch(() => null);
      if (thread?.isThread?.()) {
        if (!thread.locked) {
          markSelfChange(thread.id, { locked: true });
          await thread.setLocked(true, "Forum bridge: opening message deleted").catch(() => {});
        }
        if (!thread.archived) await thread.setArchived(true, "Forum bridge: opening message deleted").catch(() => {});
      }
    } else {
      await deletePost(post.postId, { origin: ORIGIN.DISCORD });
    }
  });
}

export async function handleMessageDeleteBulk(messages) {
  for (const message of messages.values()) {
    await handleMessageDelete(message);
  }
}

// --------------------------------------------------------------------------
// Forum posts (threads)
// --------------------------------------------------------------------------

export async function handleThreadDelete(thread) {
  if (!isForumBridgeEnabled()) return;
  if (isSelfChange(thread.id, "deleted", true)) return;
  const discussion = await getDiscussionByThreadId(thread.id);
  if (!discussion) return;
  await runSerial(thread.id, async () => {
    // Deleted in Discord -> archived on the website, never deleted.
    await setDiscussionFlags(discussion.discussionId, { isArchived: true }, { origin: ORIGIN.DISCORD });
    await setDiscussionDiscordIds(discussion.discussionId, { threadId: null, starterMessageId: null });
  });
}

export async function handleThreadUpdate(oldThread, newThread) {
  const bridge = await bridgeForThread(newThread);
  if (!bridge) return;

  // Only the exact name/lock the bridge itself set is skipped; anything else a
  // Discord moderator does in the meantime is still mirrored.
  const renamed =
    oldThread?.name !== undefined &&
    oldThread.name !== newThread.name &&
    newThread.name &&
    !isSelfChange(newThread.id, "name", newThread.name);
  const lockChanged =
    oldThread?.locked !== undefined &&
    oldThread.locked !== newThread.locked &&
    !isSelfChange(newThread.id, "locked", Boolean(newThread.locked));
  if (!renamed && !lockChanged) return;

  const discussion = await getDiscussionByThreadId(newThread.id);
  if (!discussion) return;

  await runSerial(newThread.id, async () => {
    if (renamed) {
      await updateDiscussion(discussion.discussionId, {
        title: String(newThread.name).slice(0, 200),
        origin: ORIGIN.DISCORD,
      });
    }
    // Discord auto-archives quiet posts; only an explicit lock is mirrored.
    if (lockChanged && Boolean(newThread.locked) !== discussion.isLocked) {
      await setDiscussionFlags(discussion.discussionId, { isLocked: Boolean(newThread.locked) }, { origin: ORIGIN.DISCORD });
    }
  });
}

// --------------------------------------------------------------------------
// Reactions
// --------------------------------------------------------------------------

async function resolveReaction(reaction) {
  let r = reaction;
  if (r.partial) r = await r.fetch().catch(() => null);
  if (!r) return null;
  let message = r.message;
  if (message?.partial) message = await message.fetch().catch(() => null);
  if (!message) return null;
  return { reaction: r, message };
}

export async function handleReactionAdd(reaction, discordUser) {
  if (!isForumBridgeEnabled() || discordUser?.bot) return;
  const resolved = await resolveReaction(reaction);
  if (!resolved) return;
  const { reaction: r, message } = resolved;
  const bridge = await bridgeForThread(message.channel);
  if (!bridge) return;

  const resolvedUser = await resolveParticipant(discordUser);
  const { user } = resolvedUser;
  const reason = user ? await participationRefusal(user, bridge, "react") : resolvedUser.reason;
  if (reason) {
    await r.users.remove(discordUser.id).catch(() => {});
    await refuse(discordUser, message.channel.parent?.name || "forum", reason);
    return;
  }

  const post = await getPostByDiscordMessageId(message.id);
  if (!post) return;
  const key = emojiKeyFromDiscord(r.emoji);
  if (!key) return;
  await addReaction(post.postId, user.userId, key, { origin: ORIGIN.DISCORD });
}

export async function handleReactionRemove(reaction, discordUser) {
  if (!isForumBridgeEnabled() || discordUser?.bot) return;
  const resolved = await resolveReaction(reaction);
  if (!resolved) return;
  const { reaction: r, message } = resolved;
  if (!(await bridgeForThread(message.channel))) return;

  const post = await getPostByDiscordMessageId(message.id);
  if (!post) return;
  const linked = await getLinkedUserByDiscordId(discordUser.id);
  if (!linked) return;
  const key = emojiKeyFromDiscord(r.emoji);
  if (!key) return;
  await removeReaction(post.postId, linked.userId, key, { origin: ORIGIN.DISCORD, onlySource: "discord" });
}

export async function handleReactionRemoveAll(message) {
  if (!isForumBridgeEnabled() || !message?.id) return;
  const post = await getPostByDiscordMessageId(message.id);
  if (post) await removeDiscordReactions(post.postId);
}

export async function handleReactionRemoveEmoji(reaction) {
  if (!isForumBridgeEnabled()) return;
  const post = await getPostByDiscordMessageId(reaction?.message?.id);
  const key = emojiKeyFromDiscord(reaction?.emoji);
  if (post && key) await removeDiscordReactions(post.postId, key);
}

// --------------------------------------------------------------------------
// Catch-up after the bot was offline
// --------------------------------------------------------------------------

function snowflakeTime(id) {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
}

/**
 * Pick up forum posts and messages made in bridged channels while the bot was
 * offline. Edits and deletes made while offline are not recovered.
 */
export async function catchUpBridgedChannels(client) {
  if (!isForumBridgeEnabled()) return;
  const { listBridges } = await import("../../controllers/forumBridgeController.js");
  const bridges = await listBridges({ enabledOnly: true });
  const { default: db } = await import("../../controllers/databaseController.js");
  const query = (sql, params) =>
    new Promise((resolve, reject) => db.query(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))));

  for (const bridge of bridges) {
    try {
      const forum = await client.channels.fetch(bridge.channelId).catch(() => null);
      if (!forum?.threads) continue;
      const active = await forum.threads.fetchActive();
      const bridgeStart = bridge.createdAt ? new Date(bridge.createdAt).getTime() : 0;

      for (const thread of active.threads.values()) {
        if (thread.parentId !== forum.id) continue;
        const discussion = await getDiscussionByThreadId(thread.id);

        if (!discussion) {
          if (snowflakeTime(thread.id) < bridgeStart) continue; // predates the bridge
          const starter = await thread.fetchStarterMessage().catch(() => null);
          if (starter) await handleMessageCreate(starter);
          continue;
        }

        const [row] = await query(
          `SELECT discordMessageId FROM forumPosts
            WHERE discussionId = ? AND discordMessageId IS NOT NULL
            ORDER BY CAST(discordMessageId AS UNSIGNED) DESC LIMIT 1`,
          [discussion.discussionId]
        );
        const after = row?.discordMessageId || thread.id;
        const missed = await thread.messages.fetch({ after, limit: 100 }).catch(() => null);
        if (!missed) continue;
        const ordered = [...missed.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const message of ordered) {
          await handleMessageCreate(message);
        }
      }
    } catch (error) {
      console.error(`[forumBridge] Catch-up failed for channel ${bridge.channelId}:`, error?.message || error);
    }
  }
}
