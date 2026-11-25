/**
 * cron/forumCategoryNotifyCron.js
 *
 * Starts the per-category Discord "forum updates" notifier: subscribes to the
 * forum event bus and posts new topics/replies to each category's configured
 * Discord webhook. No schedule of its own — it is purely event-driven — but it
 * lives here so it boots with the other forum/Discord wiring.
 *
 * Categories bridged to a Discord forum channel are skipped by the notifier
 * itself, so this is safe to run alongside the bridge.
 */

import { startForumCategoryNotify } from "../lib/forums/forumCategoryNotify.mjs";

startForumCategoryNotify();
