/**
 * lib/forums/forumCategoryNotify.mjs
 *
 * Per-category Discord "forum updates" notifier.
 *
 * Subscribes to the in-process forum event bus and, when a new topic or reply
 * is created in a category that has a `discordUpdateWebhook` configured, posts
 * a short notice to that webhook.
 *
 * This is separate from the full two-way forum bridge (forumBridgeSync.mjs).
 * It is a lightweight one-way announcement, so it is intentionally skipped for
 * any category that is currently bridged to a Discord forum channel — the
 * bridge already mirrors those posts into Discord, and double-posting would be
 * noise. The bridged check is done at send time against forumBridgeChannels.
 *
 * Content that originated FROM Discord (origin "discord") is never re-announced.
 * Listener errors are swallowed so a notification failure can't break the forum
 * write that triggered it.
 */

import { Webhook, MessageBuilder } from "discord-webhook-node";
import { forumEvents, FORUM_EVENTS, ORIGIN } from "./forumEvents.mjs";
import { discussionUrl } from "./forumBridgeSync.mjs";
import { getBridgeByCategoryId } from "../../controllers/forumBridgeController.js";
import { sendWebhookMessage } from "../discord/webhooks.mjs";
import db from "../../controllers/databaseController.js";

const EMBED_COLOR = "#5865f2";

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results || [])));
  });
}

/** True when the category currently has an enabled Discord forum bridge. */
async function isCategoryBridged(categoryId) {
  try {
    const bridge = await getBridgeByCategoryId(categoryId, { enabledOnly: true });
    return Boolean(bridge);
  } catch (error) {
    // If we can't tell, err on the side of NOT double-posting.
    console.error("[forumCategoryNotify] bridge check failed:", error?.message || error);
    return true;
  }
}

async function post(webhookUrl, embed) {
  const hook = new Webhook(webhookUrl);
  // parse: [] so a user-supplied title or username can never ping anyone.
  await sendWebhookMessage(hook, embed, { context: "forumCategoryNotify", allowedMentions: { parse: [] } });
}

async function onDiscussionCreated(event) {
  if (!event || event.origin === ORIGIN.DISCORD) return;

  const [row] = await query(
    `SELECT d.title, d.slug, d.discussionId, d.categoryId,
            c.name AS categoryName, c.discordUpdateWebhook AS webhook,
            u.username AS author
       FROM forumDiscussions d
       JOIN forumCategories c ON c.categoryId = d.categoryId
       LEFT JOIN users u ON u.userId = d.createdBy
      WHERE d.discussionId = ?
      LIMIT 1`,
    [event.discussionId]
  );
  if (!row || !row.webhook) return;
  if (await isCategoryBridged(row.categoryId)) return;

  const url = discussionUrl(row.discussionId, row.slug);
  const author = row.author || "Someone";
  const embed = new MessageBuilder()
    .setTitle(`New topic in ${row.categoryName}`)
    .setDescription(`[${row.title}](${url})\nby ${author}`)
    .setColor(EMBED_COLOR)
    .setTimestamp();
  await post(row.webhook, embed);
}

async function onPostCreated(event) {
  if (!event || event.origin === ORIGIN.DISCORD) return;

  const [row] = await query(
    `SELECT p.isOriginal, d.title, d.slug, d.discussionId, d.categoryId,
            c.name AS categoryName, c.discordUpdateWebhook AS webhook,
            u.username AS author
       FROM forumPosts p
       JOIN forumDiscussions d ON d.discussionId = p.discussionId
       JOIN forumCategories c ON c.categoryId = d.categoryId
       LEFT JOIN users u ON u.userId = p.userId
      WHERE p.postId = ?
      LIMIT 1`,
    [event.postId]
  );
  if (!row || !row.webhook) return;
  // The original post is the topic itself — already covered by the "new topic"
  // notice, so only announce genuine replies here.
  if (row.isOriginal) return;
  if (await isCategoryBridged(row.categoryId)) return;

  const url = discussionUrl(row.discussionId, row.slug);
  const author = row.author || "Someone";
  const embed = new MessageBuilder()
    .setTitle(`New reply in ${row.categoryName}`)
    .setDescription(`On [${row.title}](${url})\nby ${author}`)
    .setColor(EMBED_COLOR)
    .setTimestamp();
  await post(row.webhook, embed);
}

let subscribed = false;

/** Subscribe to forum events for per-category Discord updates. Idempotent. */
export function startForumCategoryNotify() {
  if (subscribed) return;
  subscribed = true;
  forumEvents.on(FORUM_EVENTS.DISCUSSION_CREATED, (event) => {
    onDiscussionCreated(event).catch((error) =>
      console.error("[forumCategoryNotify] discussion.created failed:", error?.message || error)
    );
  });
  forumEvents.on(FORUM_EVENTS.POST_CREATED, (event) => {
    onPostCreated(event).catch((error) =>
      console.error("[forumCategoryNotify] post.created failed:", error?.message || error)
    );
  });
}
