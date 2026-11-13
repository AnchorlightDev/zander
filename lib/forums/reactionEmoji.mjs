/**
 * lib/forums/reactionEmoji.mjs
 *
 * Emoji keys for forum post reactions, shared by the website and the Discord
 * bridge. A key is either a Unicode emoji ("👍") or a Discord custom emoji in
 * Discord's own mention form ("<:name:id>" / "<a:name:id>").
 *
 * Imports nothing, so it is unit-testable.
 */

/** Emoji a website user can pick without one already being on the post. */
export const WEB_REACTION_PALETTE = Object.freeze(["👍", "❤️", "😂", "🎉", "😮", "🙏", "👀", "🔥"]);

const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/;
const MAX_UNICODE_LENGTH = 32;

/**
 * Parse a stored emoji key.
 * @param {string} key
 * @returns {{type:"unicode", key:string} | {type:"custom", key:string, name:string, id:string, animated:boolean, imageUrl:string} | null}
 */
export function parseEmojiKey(key) {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;

  const custom = CUSTOM_EMOJI.exec(trimmed);
  if (custom) {
    const animated = custom[1] === "a";
    return {
      type: "custom",
      key: trimmed,
      name: custom[2],
      id: custom[3],
      animated,
      imageUrl: `https://cdn.discordapp.com/emojis/${custom[3]}.${animated ? "gif" : "webp"}?size=48`,
    };
  }

  if (trimmed.length > MAX_UNICODE_LENGTH) return null;
  // Must contain at least one pictographic / emoji code point and no
  // markup-ish characters, so arbitrary text cannot be stored as a "reaction".
  if (/[<>&"'`\s]/.test(trimmed)) return null;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|⃣/u.test(trimmed)) return null;
  return { type: "unicode", key: trimmed };
}

/**
 * The key to store for a discord.js ReactionEmoji / GuildEmoji.
 * @param {{ id?: string|null, name?: string|null, animated?: boolean|null }} emoji
 * @returns {string|null}
 */
export function emojiKeyFromDiscord(emoji) {
  if (!emoji) return null;
  if (emoji.id) {
    if (!emoji.name) return null;
    return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
  }
  return emoji.name || null;
}

/**
 * What discord.js accepts for message.react() / reactions.resolve():
 * the Unicode string, or the custom emoji id.
 * @param {string} key
 * @returns {string|null}
 */
export function discordReactIdentifier(key) {
  const parsed = parseEmojiKey(key);
  if (!parsed) return null;
  return parsed.type === "custom" ? parsed.id : parsed.key;
}

/**
 * May a website user react with this key on this post? Palette emoji always;
 * anything else only if someone already reacted with it (e.g. a Discord custom
 * emoji), so the website can "+1" it but not invent arbitrary ones.
 * @param {string} key
 * @param {string[]} existingKeys emoji already on the post
 */
export function isAllowedWebReaction(key, existingKeys = []) {
  const parsed = parseEmojiKey(key);
  if (!parsed) return false;
  return WEB_REACTION_PALETTE.includes(parsed.key) || existingKeys.includes(parsed.key);
}

/**
 * Group raw reaction rows into per-emoji summaries for display.
 * @param {{emoji:string, userId:number, username?:string, source?:string}[]} rows
 * @param {number|null} viewerUserId
 */
export function summariseReactions(rows = [], viewerUserId = null) {
  const byEmoji = new Map();
  for (const row of rows) {
    const parsed = parseEmojiKey(row.emoji);
    if (!parsed) continue;
    if (!byEmoji.has(parsed.key)) {
      byEmoji.set(parsed.key, { emoji: parsed, count: 0, users: [], reacted: false });
    }
    const entry = byEmoji.get(parsed.key);
    entry.count += 1;
    if (row.username) entry.users.push(row.username);
    if (viewerUserId && Number(row.userId) === Number(viewerUserId)) entry.reacted = true;
  }
  return [...byEmoji.values()].sort((a, b) => b.count - a.count);
}
