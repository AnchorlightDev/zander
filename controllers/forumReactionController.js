/**
 * controllers/forumReactionController.js
 *
 * Reactions on forum posts. A reaction is one row per (post, user, emoji);
 * `source` records where it was made ("web" or "discord") so the Discord bridge
 * knows which rows it mirrors from Discord and which it must show there.
 */

import db from "./databaseController.js";
import { emitForumEvent, FORUM_EVENTS, ORIGIN } from "../lib/forums/forumEvents.mjs";
import { parseEmojiKey, summariseReactions } from "../lib/forums/reactionEmoji.mjs";

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}

/** Raw reaction rows (with usernames) for a set of posts. */
export async function getReactionRowsForPosts(postIds = []) {
  const ids = [...new Set(postIds.filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return query(
    `SELECT r.postId, r.userId, r.emoji, r.source, u.username
       FROM forumPostReactions r
       LEFT JOIN users u ON u.userId = r.userId
      WHERE r.postId IN (${placeholders})
      ORDER BY r.createdAt ASC, r.reactionId ASC`,
    ids
  );
}

/** Map postId -> summarised reactions, for rendering a discussion. */
export async function getReactionSummaries(postIds = [], viewerUserId = null) {
  const rows = await getReactionRowsForPosts(postIds);
  const byPost = new Map();
  for (const row of rows) {
    if (!byPost.has(row.postId)) byPost.set(row.postId, []);
    byPost.get(row.postId).push(row);
  }
  const result = new Map();
  for (const [postId, postRows] of byPost) {
    result.set(postId, summariseReactions(postRows, viewerUserId));
  }
  return result;
}

/** Distinct emoji keys already on a post. */
export async function getPostEmojiKeys(postId) {
  const rows = await query(`SELECT DISTINCT emoji FROM forumPostReactions WHERE postId = ?`, [postId]);
  return rows.map((row) => row.emoji);
}

/** How many website-made reactions a post has for one emoji. */
export async function countWebReactions(postId, emoji) {
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM forumPostReactions WHERE postId = ? AND emoji = ? AND source = 'web'`,
    [postId, emoji]
  );
  return Number(row?.total || 0);
}

/**
 * Add a reaction. Idempotent: reacting twice with the same emoji is a no-op.
 * @returns {Promise<boolean>} true if a row was added
 */
export async function addReaction(postId, userId, emoji, { origin = ORIGIN.WEB } = {}) {
  const parsed = parseEmojiKey(emoji);
  if (!parsed || !postId || !userId) return false;
  const source = origin === ORIGIN.DISCORD ? "discord" : "web";
  const result = await query(
    `INSERT IGNORE INTO forumPostReactions (postId, userId, emoji, source) VALUES (?, ?, ?, ?)`,
    [postId, userId, parsed.key, source]
  );
  const added = Number(result?.affectedRows || 0) > 0;
  if (added) {
    emitForumEvent(FORUM_EVENTS.REACTION_CHANGED, { postId, emoji: parsed.key, origin });
  }
  return added;
}

/**
 * Remove a reaction. With `onlySource`, only a row made on that side is
 * removed (a Discord un-react must not remove the same user's web reaction).
 * @returns {Promise<boolean>} true if a row was removed
 */
export async function removeReaction(postId, userId, emoji, { origin = ORIGIN.WEB, onlySource = null } = {}) {
  const parsed = parseEmojiKey(emoji);
  if (!parsed || !postId || !userId) return false;
  const params = [postId, userId, parsed.key];
  let sourceClause = "";
  if (onlySource) {
    sourceClause = " AND source = ?";
    params.push(onlySource);
  }
  const result = await query(
    `DELETE FROM forumPostReactions WHERE postId = ? AND userId = ? AND emoji = ?${sourceClause}`,
    params
  );
  const removed = Number(result?.affectedRows || 0) > 0;
  if (removed) {
    emitForumEvent(FORUM_EVENTS.REACTION_CHANGED, { postId, emoji: parsed.key, origin });
  }
  return removed;
}

/**
 * Remove every Discord-made reaction on a post, optionally for one emoji
 * (Discord's "remove all reactions" / "remove emoji" moderator actions).
 */
export async function removeDiscordReactions(postId, emoji = null) {
  const params = [postId];
  let emojiClause = "";
  if (emoji) {
    emojiClause = " AND emoji = ?";
    params.push(emoji);
  }
  await query(
    `DELETE FROM forumPostReactions WHERE postId = ? AND source = 'discord'${emojiClause}`,
    params
  );
}

/** Has this user got a reaction with this emoji on this post (any source)? */
export async function hasReaction(postId, userId, emoji) {
  const [row] = await query(
    `SELECT reactionId FROM forumPostReactions WHERE postId = ? AND userId = ? AND emoji = ? LIMIT 1`,
    [postId, userId, emoji]
  );
  return !!row;
}
