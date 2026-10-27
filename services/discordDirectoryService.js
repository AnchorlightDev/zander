/**
 * services/discordDirectoryService.js
 *
 * The Discord server's channels, categories and roles, for the searchable
 * pickers on /dashboard/settings. Read from the bot's guild and cached
 * briefly. Returns null when the bot is offline or no guild is set, and the
 * settings page falls back to a plain ID box.
 */

import { ChannelType } from "discord.js";
import { client } from "../controllers/discordController.js";

const CACHE_MS = 60_000;
let cache = { guildId: null, at: 0, data: null };

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/**
 * Shape raw guild channels and roles into picker options. Pure, so it can be
 * tested with plain objects.
 *
 * @param {Array<{ id, name, type, parentId?, position?, rawPosition? }>} channels
 * @param {Array<{ id, name, position?, managed?, color? }>} roles
 * @param {string} guildId  The @everyone role shares the guild's ID and is left out.
 */
export function buildGuildDirectory(channels, roles, guildId) {
  const byPosition = (a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0);
  const categoryList = channels.filter((c) => c.type === ChannelType.GuildCategory).sort(byPosition);
  const categoryName = new Map(categoryList.map((c) => [c.id, c.name]));
  const categoryOrder = new Map(categoryList.map((c, i) => [c.id, i]));

  const textChannels = channels
    .filter((c) => TEXT_TYPES.has(c.type))
    .sort((a, b) => {
      const groupA = a.parentId ? categoryOrder.get(a.parentId) ?? 999 : -1;
      const groupB = b.parentId ? categoryOrder.get(b.parentId) ?? 999 : -1;
      return groupA - groupB || byPosition(a, b);
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      group: (c.parentId && categoryName.get(c.parentId)) || "No category",
      announcement: c.type === ChannelType.GuildAnnouncement,
    }));

  const roleList = roles
    .filter((r) => r.id !== guildId && !r.managed)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map((r) => ({ id: r.id, name: r.name, color: r.color ? `#${Number(r.color).toString(16).padStart(6, "0")}` : null }));

  return {
    channels: textChannels,
    categories: categoryList.map((c) => ({ id: c.id, name: c.name })),
    roles: roleList,
  };
}

/** The directory for `guildId`, or null when it cannot be read right now. */
export async function getGuildDirectory(guildId) {
  if (!guildId || !client?.isReady?.()) return null;
  if (cache.guildId === guildId && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const guild = await client.guilds.fetch(guildId);
    const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
    const data = buildGuildDirectory([...channels.values()].filter(Boolean), [...roles.values()], guildId);
    cache = { guildId, at: Date.now(), data };
    return data;
  } catch (error) {
    console.error(`[settings] Could not list Discord channels and roles for guild ${guildId}:`, error.message);
    return cache.guildId === guildId ? cache.data : null;
  }
}

/** The servers the bot is in, for the guild picker. Null while the bot is offline. */
export function getBotGuilds() {
  if (!client?.isReady?.()) return null;
  return [...client.guilds.cache.values()]
    .map((g) => ({ id: g.id, name: g.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
