/**
 * lib/discord/inviteAllowlist.mjs
 *
 * Inside the community's own Discord server, links back to that server are
 * fine: invites to it (including event invites, `discord.gg/code?event=...`),
 * its scheduled-event links and its message links. Everywhere else -- other
 * servers' invites in Discord, and any Discord link in in-game chat or
 * profile text -- the filter still blocks them.
 *
 * Only the Discord bot applies this (listeners/filter.js): it removes the
 * server's own links from a message before sending the rest to /api/filter.
 *
 * Pure apart from the injected `resolveInviteGuildId`, so it is unit-testable.
 */

const INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})(?:\?[^\s]*)?/gi;
const GUILD_PATH =
  /(?:https?:\/\/)?(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/(?:events|channels)\/(\d{17,20})(?:\/[^\s]*)?/gi;

/**
 * Remove links to the server's own guild from `content`.
 *
 * @param {string} content
 * @param {object} opts
 * @param {string} opts.guildId  the community server's ID
 * @param {(code: string) => Promise<string|null>} opts.resolveInviteGuildId
 *        which guild an invite code belongs to (null if unknown/invalid)
 * @returns {Promise<string>} content with own-server links removed
 */
export async function stripOwnServerLinks(content, { guildId, resolveInviteGuildId }) {
  if (!content || !guildId) return content;
  let out = String(content);

  // Event and message links carry the guild ID in the path.
  out = out.replace(GUILD_PATH, (match, linkGuildId) => (linkGuildId === String(guildId) ? " " : match));

  // Invite codes have to be looked up.
  const invites = [...out.matchAll(INVITE)];
  for (const [match, code] of invites) {
    let owner = null;
    try {
      owner = await resolveInviteGuildId(code);
    } catch {
      owner = null;
    }
    if (owner && String(owner) === String(guildId)) out = out.replace(match, " ");
  }

  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Wrap an invite lookup with a cache, so a busy channel sharing the same
 * invite does not hit Discord's API every message.
 *
 * @param {(code: string) => Promise<string|null>} lookup
 * @param {{ ttlMs?: number, missTtlMs?: number, now?: () => number }} [opts]
 */
export function cachedInviteResolver(lookup, { ttlMs = 60 * 60_000, missTtlMs = 10 * 60_000, now = Date.now } = {}) {
  const cache = new Map();
  return async (code) => {
    const key = String(code);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.guildId;
    let guildId = null;
    try {
      guildId = (await lookup(key)) || null;
    } catch {
      guildId = null;
    }
    cache.set(key, { guildId, expires: now() + (guildId ? ttlMs : missTtlMs) });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return guildId;
  };
}
