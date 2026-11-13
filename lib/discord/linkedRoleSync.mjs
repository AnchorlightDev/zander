/**
 * lib/discord/linkedRoleSync.mjs
 *
 * Keeps the "Linked account" Discord role (config.discord.roles.linked) on
 * exactly the members whose Discord is linked to a real, enabled website
 * account. Bridged forum channels let only this role post and react.
 *
 * Called on link / unlink / member join, and reconciled by
 * cron/linkedRoleSyncCron.js to catch anything that drifted. Never throws.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../config/config.cjs");

/** Pure: which members should gain / lose the role. */
export function diffLinkedRole(members, linkedIds, roleId) {
  const toAdd = [];
  const toRemove = [];
  for (const member of members) {
    if (member.bot) continue;
    const has = member.roleIds.includes(roleId);
    const should = linkedIds.has(String(member.id));
    if (should && !has) toAdd.push(member.id);
    if (!should && has) toRemove.push(member.id);
  }
  return { toAdd, toRemove };
}

function linkedRoleId() {
  return config.discord?.roles?.linked || null;
}

async function getGuild() {
  const guildId = config.discord?.guildId;
  if (!guildId) return null;
  const { client } = await import("../../controllers/discordController.js");
  if (!client?.isReady?.()) return null;
  return client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
}

/** Add or remove the role for one Discord user, based on the database. */
export async function syncLinkedRoleForDiscordId(discordId) {
  const roleId = linkedRoleId();
  if (!roleId || !discordId) return { ok: false, reason: "NOT_CONFIGURED" };
  try {
    const guild = await getGuild();
    if (!guild) return { ok: false, reason: "NO_GUILD" };
    const member = await guild.members.fetch(String(discordId)).catch(() => null);
    if (!member || member.user?.bot) return { ok: false, reason: "MEMBER_NOT_IN_GUILD" };

    const { getLinkedUserByDiscordId } = await import("../../controllers/forumBridgeController.js");
    const linked = Boolean(await getLinkedUserByDiscordId(discordId));
    const has = member.roles.cache.has(roleId);

    if (linked && !has) await member.roles.add(roleId, "Discord linked to a website account");
    if (!linked && has) await member.roles.remove(roleId, "Discord no longer linked to a website account");
    return { ok: true, linked };
  } catch (error) {
    console.error(`[linkedRoleSync] Failed for ${discordId}:`, error?.message || error);
    return { ok: false, reason: "ERROR", error: error?.message };
  }
}

/** Reconcile the role across the whole guild. */
export async function reconcileLinkedRoles() {
  const roleId = linkedRoleId();
  if (!roleId) return { ok: false, reason: "NOT_CONFIGURED" };
  try {
    const guild = await getGuild();
    if (!guild) return { ok: false, reason: "NO_GUILD" };
    const { ensureGuildMembers } = await import("./guildMembers.mjs");
    const members = await ensureGuildMembers(guild);
    if (!members) return { ok: false, reason: "NO_MEMBERS" };

    const { getAllLinkedDiscordIds } = await import("../../controllers/forumBridgeController.js");
    const linkedIds = await getAllLinkedDiscordIds();
    const plain = [...members.values()].map((m) => ({
      id: m.id,
      bot: Boolean(m.user?.bot),
      roleIds: [...m.roles.cache.keys()],
    }));
    const { toAdd, toRemove } = diffLinkedRole(plain, linkedIds, roleId);

    for (const id of toAdd) {
      await members.get(id)?.roles.add(roleId, "Discord linked to a website account").catch(() => {});
    }
    for (const id of toRemove) {
      await members.get(id)?.roles.remove(roleId, "Discord no longer linked to a website account").catch(() => {});
    }
    return { ok: true, added: toAdd.length, removed: toRemove.length };
  } catch (error) {
    console.error("[linkedRoleSync] Reconcile failed:", error?.message || error);
    return { ok: false, reason: "ERROR", error: error?.message };
  }
}
