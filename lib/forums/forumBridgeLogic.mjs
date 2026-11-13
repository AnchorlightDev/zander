/**
 * lib/forums/forumBridgeLogic.mjs
 *
 * Pure helpers for the forum <-> Discord forum channel bridge: content
 * conversion both ways, Discord limits, outbox backoff, and which outbox
 * actions a forum event turns into.
 *
 * Imports only other dependency-free modules, so it is unit-testable.
 */

import { htmlToDiscordMarkdown } from "../discord/htmlToDiscordMarkdown.mjs";
import { FORUM_EVENTS, ORIGIN } from "./forumEvents.mjs";

/** Discord hard limits. */
export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISCORD_THREAD_NAME_LIMIT = 100;

/** Outbox retry policy. */
export const MAX_OUTBOX_ATTEMPTS = 8;

/** Delay before retry number `attempt` (1-based): 30s, 60s, 2m ... capped at 1h. */
export function nextAttemptDelayMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(30_000 * 2 ** (n - 1), 60 * 60_000);
}

/** The actions the outbox processor understands. */
export const OUTBOX_ACTIONS = Object.freeze({
  CREATE_THREAD: "create_thread",
  EDIT_STARTER: "edit_starter",
  RENAME_THREAD: "rename_thread",
  SET_THREAD_STATE: "set_thread_state",
  DELETE_THREAD: "delete_thread",
  CLOSE_MOVED_THREAD: "close_moved_thread",
  CREATE_MESSAGE: "create_message",
  EDIT_MESSAGE: "edit_message",
  DELETE_MESSAGE: "delete_message",
  SYNC_REACTION: "sync_reaction",
});

/**
 * Turn a forum event into outbox tasks. `isBridged(categoryId)` says whether a
 * category is bridged. Events that came from Discord produce nothing (loop
 * guard), except a move, which Discord cannot cause.
 *
 * @param {string} name FORUM_EVENTS value
 * @param {object} event payload from forumController / forumReactionController
 * @param {{ isBridged: (categoryId:number) => boolean, categoryId?: number|null }} ctx
 *   categoryId: the discussion's current category, for post/reaction events
 *   whose payload only names the post.
 * @returns {{action:string, discussionId?:number|null, postId?:number|null, payload?:object|null}[]}
 */
export function planOutboxTasks(name, event, ctx) {
  if (!event || event.origin === ORIGIN.DISCORD) return [];
  const categoryId = event.categoryId ?? ctx.categoryId ?? null;
  const bridged = categoryId != null && ctx.isBridged(categoryId);

  switch (name) {
    case FORUM_EVENTS.DISCUSSION_CREATED:
      return bridged ? [{ action: OUTBOX_ACTIONS.CREATE_THREAD, discussionId: event.discussionId }] : [];

    case FORUM_EVENTS.DISCUSSION_UPDATED: {
      if (!bridged) return [];
      const tasks = [];
      if (event.titleChanged) tasks.push({ action: OUTBOX_ACTIONS.RENAME_THREAD, discussionId: event.discussionId });
      if (event.contentChanged) tasks.push({ action: OUTBOX_ACTIONS.EDIT_STARTER, discussionId: event.discussionId });
      return tasks;
    }

    case FORUM_EVENTS.DISCUSSION_FLAGS:
      return bridged
        ? [{
            action: OUTBOX_ACTIONS.SET_THREAD_STATE,
            discussionId: event.discussionId,
            payload: { isLocked: !!event.isLocked, isArchived: !!event.isArchived },
          }]
        : [];

    case FORUM_EVENTS.DISCUSSION_DELETED:
      // The discussion row is gone, so the thread id travels in the payload.
      return event.discordThreadId
        ? [{ action: OUTBOX_ACTIONS.DELETE_THREAD, discussionId: null, payload: { threadId: event.discordThreadId } }]
        : [];

    case FORUM_EVENTS.DISCUSSION_MOVED: {
      // A Discord post cannot move between forum channels. Leaving a bridged
      // category closes the Discord post with a pointer to the website.
      const leftBridge = event.fromCategoryId != null && ctx.isBridged(event.fromCategoryId);
      return event.discordThreadId && leftBridge
        ? [{ action: OUTBOX_ACTIONS.CLOSE_MOVED_THREAD, discussionId: event.discussionId, payload: { threadId: event.discordThreadId } }]
        : [];
    }

    case FORUM_EVENTS.POST_CREATED:
      return bridged ? [{ action: OUTBOX_ACTIONS.CREATE_MESSAGE, discussionId: event.discussionId, postId: event.postId }] : [];

    case FORUM_EVENTS.POST_UPDATED:
      if (!bridged) return [];
      return event.isOriginal
        ? [{ action: OUTBOX_ACTIONS.EDIT_STARTER, discussionId: event.discussionId }]
        : [{ action: OUTBOX_ACTIONS.EDIT_MESSAGE, discussionId: event.discussionId, postId: event.postId }];

    case FORUM_EVENTS.POST_DELETED:
      return event.discordMessageId
        ? [{
            action: OUTBOX_ACTIONS.DELETE_MESSAGE,
            discussionId: event.discussionId,
            payload: { messageId: event.discordMessageId },
          }]
        : [];

    case FORUM_EVENTS.REACTION_CHANGED:
      return bridged
        ? [{ action: OUTBOX_ACTIONS.SYNC_REACTION, postId: event.postId, discussionId: ctx.discussionId ?? null, payload: { emoji: event.emoji } }]
        : [];

    default:
      return [];
  }
}

// --------------------------------------------------------------------------
// Website -> Discord content
// --------------------------------------------------------------------------

/** Clamp a thread title to Discord's 100 characters. */
export function toThreadName(title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim() || "Discussion";
  return clean.length > DISCORD_THREAD_NAME_LIMIT
    ? `${clean.slice(0, DISCORD_THREAD_NAME_LIMIT - 1).trimEnd()}…`
    : clean;
}

/**
 * Webhook display names must be 1-80 characters and may not contain
 * "discord" or "clyde" (Discord rejects the request otherwise).
 */
export function toWebhookUsername(username) {
  let name = String(username || "Player").trim() || "Player";
  name = name.replace(/discord/gi, "d1scord").replace(/clyde/gi, "c1yde");
  return name.slice(0, 80);
}

/** Player head for a webhook avatar. */
export function avatarUrlFor(uuid) {
  return uuid ? `https://crafthead.net/helm/${uuid}` : "https://crafthead.net/helm/steve";
}

/** Keep inline images visible: Discord unfurls a bare image URL. */
function imagesToUrls(html) {
  return String(html || "").replace(
    /<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi,
    (_m, src) => `<p>${src}</p>`
  );
}

/** Stop @everyone / @here in website content from reading as pings. */
function defuseMassMentions(text) {
  return text.replace(/@(everyone|here)/gi, "@​$1");
}

/**
 * Build the Discord message body for a website post.
 * @param {string} html sanitised post HTML
 * @param {{ postUrl?: string, replyToUsername?: string|null, replyToUrl?: string|null }} opts
 */
export function formatWebPostForDiscord(html, { postUrl = "", replyToUsername = null, replyToUrl = null } = {}) {
  let body = htmlToDiscordMarkdown(imagesToUrls(html));
  body = defuseMassMentions(body);

  let prefix = "";
  if (replyToUsername) {
    const who = replyToUsername.replace(/[*_~`|>]/g, "");
    prefix = replyToUrl ? `-# ↪ Replying to **${who}** · [jump](<${replyToUrl}>)\n` : `-# ↪ Replying to **${who}**\n`;
  }

  const full = `${prefix}${body}`.trim() || "​";
  if (full.length <= DISCORD_MESSAGE_LIMIT) return full;

  const more = postUrl ? `\n\n… [Read the rest on the website](<${postUrl}>)` : "\n\n…";
  return `${full.slice(0, DISCORD_MESSAGE_LIMIT - more.length).trimEnd()}${more}`;
}

// --------------------------------------------------------------------------
// Discord -> Website content
// --------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

/**
 * Convert Discord-flavoured markdown to the forum's HTML. The result still
 * goes through sanitizeForumHtml in the controller; this only maps syntax.
 *
 * @param {string} markdown
 * @param {{
 *   resolveUser?: (id:string) => string|null,
 *   resolveChannel?: (id:string) => string|null,
 *   resolveRole?: (id:string) => string|null,
 * }} resolvers return a display name, or null if unknown
 */
export function discordMarkdownToHtml(markdown, resolvers = {}) {
  const { resolveUser = () => null, resolveChannel = () => null, resolveRole = () => null } = resolvers;
  if (!markdown) return "";

  // Pull code out first so nothing inside it is treated as markdown.
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let s = String(markdown).replace(/\r\n?/g, "\n");
  s = s.replace(/```(?:[a-zA-Z0-9_+-]*\n)?([\s\S]*?)```/g, (_m, code) => keep(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${escapeHtml(code)}</code>`));

  // Discord tokens, before escaping eats their angle brackets.
  s = s.replace(/<a?:([A-Za-z0-9_]{2,32}):(\d{15,25})>/g, (_m, name, id) =>
    keep(`<img src="https://cdn.discordapp.com/emojis/${id}.webp?size=48" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:" width="22" height="22">`)
  );
  s = s.replace(/<@!?(\d{15,25})>/g, (_m, id) => keep(`<strong>@${escapeHtml(resolveUser(id) || "unknown-user")}</strong>`));
  s = s.replace(/<@&(\d{15,25})>/g, (_m, id) => keep(`<strong>@${escapeHtml(resolveRole(id) || "role")}</strong>`));
  s = s.replace(/<#(\d{15,25})>/g, (_m, id) => keep(`<strong>#${escapeHtml(resolveChannel(id) || "channel")}</strong>`));
  s = s.replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (_m, secs) => {
    const date = new Date(Number(secs) * 1000);
    return keep(Number.isNaN(date.getTime()) ? "" : escapeHtml(date.toUTCString()));
  });
  // <https://link> is Discord's "no embed" link syntax.
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (_m, url) => url);

  s = escapeHtml(s);

  // Masked links [text](url).
  s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) =>
    SAFE_URL.test(url.replace(/&amp;/g, "&")) ? keep(`<a href="${url}">${text}</a>`) : text
  );
  // Bare URLs.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+)/g, (_m, lead, url) => `${lead}${keep(`<a href="${url}">${url}</a>`)}`);

  // Inline formatting (order matters: *** before ** before *).
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<u>$1</u>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span style="background-color: #1f2937; color: #1f2937">$1</span>');

  // Block structure, line by line.
  const out = [];
  let list = null; // "ul" | "ol"
  let quote = [];
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
      quote = [];
    }
  };

  for (const rawLine of s.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    let m;
    if ((m = /^&gt;&gt;&gt; ?(.*)$/.exec(line)) || (m = /^&gt; ?(.*)$/.exec(line))) {
      flushList();
      quote.push(m[1]);
      continue;
    }
    flushQuote();
    if ((m = /^-# (.+)$/.exec(line))) {
      flushList();
      out.push(`<p><small>${m[1]}</small></p>`);
    } else if ((m = /^(#{1,3}) (.+)$/.exec(line))) {
      flushList();
      const level = m[1].length + 2; // # -> h3, ## -> h4, ### -> h5 (post headings stay below the page title)
      out.push(`<h${level}>${m[2]}</h${level}>`);
    } else if ((m = /^\s*[-*] (.+)$/.exec(line))) {
      if (list !== "ul") {
        flushList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${m[1]}</li>`);
    } else if ((m = /^\s*\d+[.)] (.+)$/.exec(line))) {
      if (list !== "ol") {
        flushList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${m[1]}</li>`);
    } else if (!line.trim()) {
      flushList();
      out.push("");
    } else if ((m = /^\u0000(\d+)\u0000$/.exec(line.trim())) && /^<pre/.test(stash[Number(m[1])] || "")) {
      // A code block on its own line is already a block element.
      flushList();
      out.push(line.trim());
    } else {
      flushList();
      out.push(`<p>${line}</p>`);
    }
  }
  flushList();
  flushQuote();

  let html = out.filter((part, i, arr) => part !== "" || (i > 0 && arr[i - 1] !== "")).join("").trim();
  // Restore stashed fragments (may nest, so loop until stable).
  for (let guard = 0; guard < 5 && html.includes("\u0000"); guard += 1) {
    html = html.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)] ?? "");
  }
  return html;
}

/**
 * HTML for a Discord message's attachments. `hostedUrls` maps attachment id to
 * a re-hosted copy (Discord's own CDN links expire after about a day).
 *
 * @param {{id:string, name:string, url:string, contentType?:string|null}[]} attachments
 * @param {Map<string,string>} hostedUrls
 */
export function attachmentsToHtml(attachments = [], hostedUrls = new Map()) {
  const parts = [];
  for (const att of attachments) {
    const url = hostedUrls.get(att.id) || att.url;
    if (!url || !SAFE_URL.test(url)) continue;
    const name = escapeHtml(att.name || "attachment");
    const isImage = /^image\//.test(att.contentType || "") || /\.(png|jpe?g|gif|webp)$/i.test(att.name || "");
    if (isImage && hostedUrls.has(att.id)) {
      parts.push(`<p><img src="${escapeHtml(url)}" alt="${name}"></p>`);
    } else {
      parts.push(`<p><a href="${escapeHtml(url)}">📎 ${name}</a></p>`);
    }
  }
  return parts.join("");
}

function decodeAttr(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Re-hosted image URLs already in a post's stored HTML, keyed by the
 * attachment id they belong to (matched by file name, in order), so editing a
 * Discord message does not upload its images again. Discord CDN links are
 * never reused: they expire.
 */
export function reusableHostedUrls(storedHtml, attachments = []) {
  const byName = new Map();
  const re = /<img\b[^>]*?\bsrc="([^"]+)"[^>]*?\balt="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = re.exec(String(storedHtml || "")))) {
    const url = decodeAttr(match[1]);
    if (!SAFE_URL.test(url) || /^https?:\/\/([^/]*\.)?discordapp\.(com|net)\//i.test(url)) continue;
    const name = decodeAttr(match[2]);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(url);
  }
  const hosted = new Map();
  for (const att of attachments) {
    const queue = byName.get(String(att.name || "attachment"));
    if (queue?.length) hosted.set(att.id, queue.shift());
  }
  return hosted;
}

/**
 * Did a Discord message update change anything the website shows? Discord
 * also sends updates for embed unfurls, pins and flag changes. Returns null
 * when the old message is not cached, so the caller cannot tell.
 */
export function discordMessageContentChanged(oldMessage, newMessage) {
  if (!oldMessage || oldMessage.partial || typeof oldMessage.content !== "string") return null;
  const ids = (collection) => [...(collection?.keys?.() || [])].join(",");
  return (
    oldMessage.content !== newMessage.content ||
    ids(oldMessage.attachments) !== ids(newMessage.attachments) ||
    ids(oldMessage.stickers) !== ids(newMessage.stickers)
  );
}

/** Website node that lets a member reply to a locked or archived discussion. */
export const FORUM_MODERATE_PERMISSION = "zander.forums.moderate";

/**
 * Does checking a Discord member's part in a bridged channel need their
 * website permissions? (Loading them hits LuckPerms, so skip when it can't matter.)
 * action: "start" (new forum post), "reply" or "react".
 */
export function bridgeCheckNeedsPermissions({ bridge, action, discussion = null }) {
  if (bridge?.viewPermission) return true;
  if (action === "start") return Boolean(bridge?.postPermission);
  if (action === "reply") return Boolean(discussion && (discussion.isLocked || discussion.isArchived));
  return false;
}

/**
 * Why a linked Discord member may not do this in a bridged channel, mirroring
 * the website's own checks, or null when they may. `matches(permissions, node)`
 * is forumController.permissionMatch (passed in to keep this module pure).
 * Reasons: "view" (category hidden from them), "permission" (may not start
 * posts), "closed" (discussion locked or archived and they are not a moderator).
 */
export function bridgeParticipationRefusal({ permissions, bridge, action, discussion = null, matches }) {
  if (bridge?.viewPermission && !matches(permissions, bridge.viewPermission)) return "view";
  if (action === "start" && bridge?.postPermission && !matches(permissions, bridge.postPermission)) return "permission";
  if (
    action === "reply" &&
    discussion &&
    (discussion.isLocked || discussion.isArchived) &&
    !matches(permissions, FORUM_MODERATE_PERMISSION)
  ) {
    return "closed";
  }
  return null;
}

/** True when converted content has nothing a reader would see. */
export function isEffectivelyEmpty(html) {
  return !String(html || "")
    .replace(/<(?!img\b)[^>]{0,2000}>/gi, "")
    .replace(/&nbsp;|​/gi, "")
    .trim();
}

/** Throttle repeated DMs to the same Discord user. */
export function createDmThrottle(windowMs = 10 * 60_000, now = () => Date.now()) {
  const last = new Map();
  return function shouldSend(discordId) {
    const t = now();
    if (last.has(discordId) && t - last.get(discordId) < windowMs) return false;
    last.set(discordId, t);
    if (last.size > 5000) {
      for (const [key, value] of last) if (t - value > windowMs) last.delete(key);
    }
    return true;
  };
}
