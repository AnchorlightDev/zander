/**
 * lib/forums/forumBridgeSetup.mjs
 *
 * Dashboard-side setup for the forum bridge: list the Discord server's forum
 * channels, and connect / disconnect a category.
 *
 * Connecting a category:
 *  1. checks the channel is a forum channel in the configured server and is
 *     not already bridged to another category;
 *  2. creates (or reuses) the bridge's webhook on that channel;
 *  3. sets channel permissions so @everyone can read but not post or react,
 *     the Linked account role can post and react, and the bot can manage
 *     posts, messages and webhooks;
 *  4. saves the bridge. Only content created from now on is synced.
 *
 * Returns warnings for anything that needs a human (e.g. no Linked role set).
 */

import { createRequire } from "module";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  getBridgeByCategoryId,
  getBridgeByChannelId,
  removeBridge,
  saveBridge,
  setBridgeEnabled,
} from "../../controllers/forumBridgeController.js";
import { ensureBridgeWebhook, invalidateBridgeCache } from "./forumBridgeSync.mjs";

const require = createRequire(import.meta.url);
const config = require("../config/config.cjs");

async function getGuild() {
  const guildId = config.discord?.guildId;
  if (!guildId) return null;
  const { client } = await import("../../controllers/discordController.js");
  if (!client?.isReady?.()) return null;
  return client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
}

/** Forum channels in the configured Discord server, for the picker. */
export async function listForumChannels() {
  const guild = await getGuild();
  if (!guild) return { available: false, channels: [] };
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  const forums = [...channels.values()]
    .filter((c) => c && c.type === ChannelType.GuildForum)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
    .map((c) => ({ id: c.id, name: c.name, parentName: c.parent?.name || null }));
  return { available: true, channels: forums };
}

async function applyChannelPermissions(channel, guild, warnings) {
  const me = guild.members.me;

  try {
    await channel.permissionOverwrites.edit(
      me.id,
      {
        ViewChannel: true,
        SendMessages: true,
        SendMessagesInThreads: true,
        ManageThreads: true,
        ManageMessages: true,
        ManageWebhooks: true,
        AddReactions: true,
        ReadMessageHistory: true,
        EmbedLinks: true,
      },
      { reason: "Forum bridge: bot access" }
    );

    // Open posting: let everyone post and react. Unlinked members are policed
    // by the bot, not by channel permissions — handleMessageCreate and the
    // reaction handler delete anything from a Discord account with no linked
    // website account and DM them how to link. So the bridge needs no "Linked"
    // Discord role. Visibility is left as the channel already has it (a
    // staff-only forum stays staff-only).
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: true, SendMessagesInThreads: true, CreatePublicThreads: true, AddReactions: true },
      { reason: "Forum bridge: open posting; the bot removes posts from members with no linked website account" }
    );
  } catch (error) {
    warnings.push(
      `Couldn't set the channel's permissions (${error?.message || error}). Give the bot Manage Roles and Manage Channels, or set them by hand: @everyone can send messages and add reactions (the bot removes posts from members with no linked website account).`
    );
  }

  const perms = channel.permissionsFor(me);
  const needed = [
    [PermissionFlagsBits.ManageWebhooks, "Manage Webhooks"],
    [PermissionFlagsBits.ManageThreads, "Manage Threads"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"],
    [PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"],
    [PermissionFlagsBits.AddReactions, "Add Reactions"],
  ];
  const missing = needed.filter(([flag]) => !perms?.has(flag)).map(([, label]) => label);
  if (missing.length) warnings.push(`The bot is missing these permissions in the channel: ${missing.join(", ")}.`);
}

/**
 * Bridge a category to a Discord forum channel.
 * @returns {{ ok: boolean, error?: string, warnings: string[] }}
 */
export async function connectCategoryToChannel(categoryId, channelId) {
  const warnings = [];
  const guild = await getGuild();
  if (!guild) return { ok: false, error: "The Discord bot isn't connected, or no Discord server is set in Settings.", warnings };

  const channel = await guild.channels.fetch(String(channelId)).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    return { ok: false, error: "Pick a Discord forum channel.", warnings };
  }

  const other = await getBridgeByChannelId(channel.id, { enabledOnly: false });
  if (other && Number(other.categoryId) !== Number(categoryId)) {
    return { ok: false, error: `#${channel.name} is already bridged to "${other.categoryName}".`, warnings };
  }

  const existing = await getBridgeByCategoryId(categoryId, { enabledOnly: false });
  const keepWebhook = existing && existing.channelId === channel.id ? existing.webhookId : null;
  const bridge = await saveBridge({
    categoryId,
    guildId: guild.id,
    channelId: channel.id,
    webhookId: keepWebhook,
    enabled: true,
  });

  try {
    await ensureBridgeWebhook(bridge);
  } catch (error) {
    warnings.push(`Couldn't create the channel webhook (${error?.message || error}). Website posts will retry once the bot has Manage Webhooks.`);
  }

  await applyChannelPermissions(channel, guild, warnings);
  invalidateBridgeCache();
  return { ok: true, warnings };
}

/** Stop syncing a category. Existing links stay so turning it back on is clean. */
export async function disconnectCategory(categoryId, { forget = false } = {}) {
  if (forget) await removeBridge(categoryId);
  else await setBridgeEnabled(categoryId, false);
  invalidateBridgeCache();
}
