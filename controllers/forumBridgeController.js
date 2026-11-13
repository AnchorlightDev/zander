/**
 * controllers/forumBridgeController.js
 *
 * Data access for the forum <-> Discord forum channel bridge: which category is
 * bridged to which channel, the Discord ids stored on discussions and posts,
 * and the website -> Discord outbox.
 *
 * Raw SQL through the mysql2 pool, like forumController.
 */

import db from "./databaseController.js";
import { nextAttemptDelayMs, MAX_OUTBOX_ATTEMPTS } from "../lib/forums/forumBridgeLogic.mjs";

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}

function mapBridge(row) {
  if (!row) return null;
  return {
    bridgeId: row.bridgeId,
    categoryId: row.categoryId,
    guildId: row.guildId,
    channelId: row.channelId,
    webhookId: row.webhookId || null,
    enabled: !!row.enabled,
    lastSyncedAt: row.lastSyncedAt || null,
    createdAt: row.createdAt || null,
    categoryName: row.categoryName || null,
    categorySlug: row.categorySlug || null,
    postPermission: row.postPermission || null,
    viewPermission: row.viewPermission || null,
  };
}

const BRIDGE_SELECT = `
  SELECT b.bridgeId, b.categoryId, b.guildId, b.channelId, b.webhookId, b.enabled, b.lastSyncedAt, b.createdAt,
         c.name AS categoryName, c.slug AS categorySlug, c.postPermission, c.viewPermission
    FROM forumBridgeChannels b
    JOIN forumCategories c ON c.categoryId = b.categoryId`;

// --------------------------------------------------------------------------
// Bridge configuration
// --------------------------------------------------------------------------

export async function getBridgeByCategoryId(categoryId, { enabledOnly = true } = {}) {
  if (!categoryId) return null;
  const rows = await query(
    `${BRIDGE_SELECT} WHERE b.categoryId = ?${enabledOnly ? " AND b.enabled = 1" : ""} LIMIT 1`,
    [categoryId]
  );
  return mapBridge(rows[0]);
}

export async function getBridgeByChannelId(channelId, { enabledOnly = true } = {}) {
  if (!channelId) return null;
  const rows = await query(
    `${BRIDGE_SELECT} WHERE b.channelId = ?${enabledOnly ? " AND b.enabled = 1" : ""} LIMIT 1`,
    [String(channelId)]
  );
  return mapBridge(rows[0]);
}

export async function listBridges({ enabledOnly = false } = {}) {
  const rows = await query(`${BRIDGE_SELECT}${enabledOnly ? " WHERE b.enabled = 1" : ""} ORDER BY c.name`);
  return rows.map(mapBridge);
}

/**
 * Create or update the bridge for a category. A channel can only be bridged to
 * one category; the unique key on channelId enforces that.
 */
export async function saveBridge({ categoryId, guildId, channelId, webhookId = null, enabled = true }) {
  await query(
    `INSERT INTO forumBridgeChannels (categoryId, guildId, channelId, webhookId, enabled)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
                             -- Reset the bridge's start time when it is switched back on or
                             -- moved to another channel: only content after that point syncs.
                             -- (Assignments run left to right, so this must come first.)
                             createdAt = IF(enabled = 0 OR channelId <> VALUES(channelId), NOW(), createdAt),
                             guildId = VALUES(guildId),
                             channelId = VALUES(channelId),
                             webhookId = VALUES(webhookId),
                             enabled = VALUES(enabled)`,
    [categoryId, String(guildId), String(channelId), webhookId ? String(webhookId) : null, enabled ? 1 : 0]
  );
  return getBridgeByCategoryId(categoryId, { enabledOnly: false });
}

export async function setBridgeWebhook(bridgeId, webhookId) {
  await query(`UPDATE forumBridgeChannels SET webhookId = ? WHERE bridgeId = ?`, [webhookId ? String(webhookId) : null, bridgeId]);
}

export async function setBridgeEnabled(categoryId, enabled) {
  await query(`UPDATE forumBridgeChannels SET enabled = ? WHERE categoryId = ?`, [enabled ? 1 : 0, categoryId]);
}

export async function removeBridge(categoryId) {
  await query(`DELETE FROM forumBridgeChannels WHERE categoryId = ?`, [categoryId]);
}

export async function touchBridgeSynced(bridgeId) {
  await query(`UPDATE forumBridgeChannels SET lastSyncedAt = NOW() WHERE bridgeId = ?`, [bridgeId]);
}

// --------------------------------------------------------------------------
// Discord id lookups
// --------------------------------------------------------------------------

export async function getDiscussionByThreadId(threadId) {
  if (!threadId) return null;
  const [row] = await query(
    `SELECT discussionId, categoryId, title, slug, createdBy, isLocked, isArchived, status,
            discordThreadId, discordStarterMessageId
       FROM forumDiscussions
      WHERE discordThreadId = ?
      LIMIT 1`,
    [String(threadId)]
  );
  return row ? { ...row, isLocked: !!row.isLocked, isArchived: !!row.isArchived } : null;
}

export async function getPostByDiscordMessageId(messageId) {
  if (!messageId) return null;
  const [row] = await query(
    `SELECT postId, discussionId, userId, replyToPostId, content, isOriginal, discordMessageId, source
       FROM forumPosts
      WHERE discordMessageId = ?
      LIMIT 1`,
    [String(messageId)]
  );
  return row ? { ...row, isOriginal: !!row.isOriginal } : null;
}

export async function setDiscussionDiscordIds(discussionId, { threadId, starterMessageId }) {
  await query(
    `UPDATE forumDiscussions SET discordThreadId = ?, discordStarterMessageId = ? WHERE discussionId = ?`,
    [threadId ? String(threadId) : null, starterMessageId ? String(starterMessageId) : null, discussionId]
  );
  if (starterMessageId) {
    await query(
      `UPDATE forumPosts SET discordMessageId = ? WHERE discussionId = ? AND isOriginal = 1 AND discordMessageId IS NULL`,
      [String(starterMessageId), discussionId]
    );
  }
}

export async function setPostDiscordMessageId(postId, messageId) {
  await query(`UPDATE forumPosts SET discordMessageId = ? WHERE postId = ?`, [messageId ? String(messageId) : null, postId]);
}

/** Discussion, original post and author, for posting to Discord. */
export async function getDiscussionForSync(discussionId) {
  const [row] = await query(
    `SELECT d.discussionId, d.categoryId, d.title, d.slug, d.status, d.isLocked, d.isArchived,
            d.discordThreadId, d.discordStarterMessageId,
            p.postId, p.content, p.source, p.discordMessageId,
            u.userId, u.username, u.uuid
       FROM forumDiscussions d
       JOIN forumPosts p ON p.discussionId = d.discussionId AND p.isOriginal = 1
       LEFT JOIN users u ON u.userId = p.userId
      WHERE d.discussionId = ?
      LIMIT 1`,
    [discussionId]
  );
  return row ? { ...row, isLocked: !!row.isLocked, isArchived: !!row.isArchived } : null;
}

/** A reply, its discussion's Discord ids, author, and what it replies to. */
export async function getPostForSync(postId) {
  const [row] = await query(
    `SELECT p.postId, p.discussionId, p.content, p.isOriginal, p.source, p.discordMessageId, p.replyToPostId,
            d.categoryId, d.title, d.slug, d.status, d.discordThreadId,
            u.userId, u.username, u.uuid,
            rp.discordMessageId AS replyToDiscordMessageId,
            ru.username AS replyToUsername
       FROM forumPosts p
       JOIN forumDiscussions d ON d.discussionId = p.discussionId
       LEFT JOIN users u ON u.userId = p.userId
       LEFT JOIN forumPosts rp ON rp.postId = p.replyToPostId
       LEFT JOIN users ru ON ru.userId = rp.userId
      WHERE p.postId = ?
      LIMIT 1`,
    [postId]
  );
  return row ? { ...row, isOriginal: !!row.isOriginal } : null;
}

/**
 * The website account behind a Discord user, if they have a real linked one.
 * Placeholder ("ghost") rows created for support tickets do not count, and
 * neither do disabled accounts.
 */
export async function getLinkedUserByDiscordId(discordId) {
  if (!discordId) return null;
  const [row] = await query(
    `SELECT userId, uuid, username, discordId, account_disabled, is_placeholder
       FROM users
      WHERE discordId = ?
        AND (is_placeholder = 0 OR is_placeholder IS NULL)
        AND (account_disabled = 0 OR account_disabled IS NULL)
      ORDER BY userId ASC
      LIMIT 1`,
    [String(discordId)]
  );
  return row || null;
}

/** Every Discord id with a real, enabled linked account. */
export async function getAllLinkedDiscordIds() {
  const rows = await query(
    `SELECT DISTINCT discordId
       FROM users
      WHERE discordId IS NOT NULL
        AND (is_placeholder = 0 OR is_placeholder IS NULL)
        AND (account_disabled = 0 OR account_disabled IS NULL)`
  );
  return new Set(rows.map((row) => String(row.discordId)));
}

// --------------------------------------------------------------------------
// Outbox (website -> Discord)
// --------------------------------------------------------------------------

export async function enqueueOutboxTask({ action, discussionId = null, postId = null, payload = null }) {
  const result = await query(
    `INSERT INTO forumSyncOutbox (action, discussionId, postId, payload) VALUES (?, ?, ?, ?)`,
    [action, discussionId, postId, payload ? JSON.stringify(payload) : null]
  );
  return result.insertId || null;
}

/** Due tasks, oldest first. Single process, so no row locking is needed. */
export async function getDueOutboxTasks(limit = 25) {
  const rows = await query(
    `SELECT taskId, action, discussionId, postId, payload, attempts
       FROM forumSyncOutbox
      WHERE status = 'pending'
        AND nextAttemptAt <= NOW()
      ORDER BY taskId ASC
      LIMIT ?`,
    [limit]
  );
  return rows.map((row) => {
    let payload = null;
    try {
      payload = row.payload ? JSON.parse(row.payload) : null;
    } catch {
      payload = null;
    }
    return { ...row, payload };
  });
}

export async function completeOutboxTask(taskId) {
  await query(`UPDATE forumSyncOutbox SET status = 'done', lastError = NULL WHERE taskId = ?`, [taskId]);
}

export async function failOutboxTask(taskId, attempts, errorMessage) {
  const nextAttempts = attempts + 1;
  const giveUp = nextAttempts >= MAX_OUTBOX_ATTEMPTS;
  const delaySeconds = Math.round(nextAttemptDelayMs(nextAttempts) / 1000);
  await query(
    `UPDATE forumSyncOutbox
        SET attempts = ?,
            status = ?,
            lastError = ?,
            nextAttemptAt = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE taskId = ?`,
    [nextAttempts, giveUp ? "failed" : "pending", String(errorMessage || "").slice(0, 2000), delaySeconds, taskId]
  );
  return giveUp;
}

/** Drop finished outbox rows older than a week so the table stays small. */
export async function pruneOutbox() {
  await query(`DELETE FROM forumSyncOutbox WHERE status = 'done' AND updatedAt < DATE_SUB(NOW(), INTERVAL 7 DAY)`);
}

export async function getOutboxStats(categoryId = null) {
  const rows = await query(
    `SELECT o.status, COUNT(*) AS total
       FROM forumSyncOutbox o
       LEFT JOIN forumDiscussions d ON d.discussionId = o.discussionId
      ${categoryId ? "WHERE d.categoryId = ?" : ""}
      GROUP BY o.status`,
    categoryId ? [categoryId] : []
  );
  const stats = { pending: 0, done: 0, failed: 0 };
  for (const row of rows) stats[row.status] = Number(row.total || 0);
  return stats;
}
