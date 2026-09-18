/**
 * Diffs a member's current Discord roles against the roles they should have,
 * restricted to the set of role IDs that map to a rank (`trackedRoleIds`).
 * Role IDs outside that set are never touched, even if present in the inputs.
 */
export function diffTrackedRoles(currentRoleIds, shouldHaveRoleIds, trackedRoleIds) {
  const current = new Set(currentRoleIds);
  const shouldHave = new Set(shouldHaveRoleIds);
  const tracked = new Set(trackedRoleIds);

  const toAdd = [...shouldHave].filter((id) => tracked.has(id) && !current.has(id));
  const toRemove = [...current].filter((id) => tracked.has(id) && !shouldHave.has(id));

  return { toAdd, toRemove };
}

async function queryDb(sql, params = []) {
  const { default: db } = await import("../../controllers/databaseController.js");
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

async function queryLuckPermsDb(sql, params = []) {
  const { luckpermsDb } = await import("../../controllers/databaseController.js");
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

/**
 * LuckPerms lives on a separate MySQL server from the main app DB, so it
 * cannot be joined via a cross-database SQL view — every lookup here queries
 * luckpermsDb and db independently and merges in JS (same pattern as
 * services/profileService.js:getUserRanks, which is the proven-working
 * reference for this). Nodes are scoped to server='global'/world='global' to
 * match how the dashboard's rank config editor writes them
 * (updateGroupNode() in api/routes/ranks.js) — a contextual override (e.g.
 * server=events) would otherwise shadow the intended global value.
 */

/** Every distinct Discord role ID configured on any rank (rankSlug -> discordRoleId). */
async function getTrackedRoleMap() {
  const rows = await queryLuckPermsDb(
    `SELECT name AS rankSlug, SUBSTRING_INDEX(permission, '.', -1) AS discordRoleId
       FROM luckperms_group_permissions
      WHERE permission LIKE 'meta.discordid.%' AND value = 1
        AND server = 'global' AND world = 'global'`
  );
  const map = new Map();
  for (const row of rows) {
    if (row.discordRoleId) map.set(row.rankSlug, String(row.discordRoleId));
  }
  return map;
}

/** Every distinct Discord role ID configured on any rank. */
export async function getTrackedRoleIds() {
  const map = await getTrackedRoleMap();
  return [...map.values()];
}

/**
 * Lowercases a uuid for comparison against `luckperms_user_permissions.uuid`
 * — LuckPerms' MySQL storage uses standard dashed VARCHAR(36) uuids (see
 * services/profileService.js:getUserRanks), matching `users.uuid`'s own
 * dashed format. No dash-stripping needed here.
 */
export function normalizeUuid(uuid) {
  if (!uuid) return null;
  return String(uuid).toLowerCase();
}

/** Every LuckPerms group (rankSlug) the given player uuid directly holds. */
async function getUserRankSlugs(uuid) {
  const normalized = normalizeUuid(uuid);
  if (!normalized) return [];
  const rows = await queryLuckPermsDb(
    `SELECT SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
       FROM luckperms_user_permissions
      WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1
        AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
    [normalized]
  );
  return rows.map((r) => r.rankSlug);
}

/**
 * The LuckPerms uuid to sync a website user's ranks against.
 *
 * `users.uuid` is authoritative for a normal account, but a placeholder
 * ("ghost") row — created from Discord by createUnlinkedUser() in
 * controllers/supportTicketController.js — carries a random MySQL `UUID()`,
 * not the player's Mojang uuid. Looking that random uuid up in LuckPerms
 * returns no rows, which is indistinguishable from "holds no ranks" and made
 * every rank change for such a player a no-op (or, worse, stripped the rank
 * roles they already had). For those rows we fall back to matching
 * `luckperms_players` by username.
 *
 * Returns null when no LuckPerms player can be matched at all — callers must
 * treat that as "unknown", never as "holds no ranks".
 */
export async function resolveLuckPermsUuid({ uuid, username } = {}) {
  const normalized = normalizeUuid(uuid);
  if (normalized) {
    const [byUuid] = await queryLuckPermsDb(
      `SELECT LOWER(uuid) AS uuid FROM luckperms_players WHERE uuid = ? LIMIT 1`,
      [normalized]
    );
    if (byUuid?.uuid) return byUuid.uuid;
  }

  if (!username) return null;

  const [byUsername] = await queryLuckPermsDb(
    `SELECT LOWER(uuid) AS uuid FROM luckperms_players WHERE LOWER(username) = LOWER(?) LIMIT 1`,
    [username]
  );
  return byUsername?.uuid ?? null;
}

/** Discord role IDs for every rank the given LuckPerms player uuid currently holds. */
export async function getUserRoleIdsByUuid(uuid) {
  const rankSlugs = await getUserRankSlugs(uuid);
  if (!rankSlugs.length) return [];
  const trackedRoleMap = await getTrackedRoleMap();
  return rankSlugs
    .map((slug) => trackedRoleMap.get(slug))
    .filter(Boolean);
}

import { client } from "../../controllers/discordController.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../../config.json");
const features = require("../../features.json");

async function fetchGuildMember(discordId) {
  const guildId = config.discord?.guildId;
  if (!guildId || !discordId) return null;

  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;

  return guild.members.fetch(discordId).catch(() => null);
}

/**
 * Grants/revokes the given user's rank-mapped Discord roles so their
 * Discord roles match their current LuckPerms ranks. Never throws — always
 * resolves to a result object describing what happened, so callers (e.g.
 * /forcelink) can surface sync failures instead of reporting blind success.
 */
export async function syncMemberRankRoles(userId, { luckPermsUuid = null } = {}) {
  if (!features.ranks) return { ok: false, reason: "FEATURE_DISABLED" };
  if (!userId) return { ok: false, reason: "NO_USER_ID" };

  try {
    const [webUser] = await queryDb(
      `SELECT uuid, username, discordId FROM users WHERE userId = ? LIMIT 1`,
      [userId]
    );
    if (!webUser?.discordId) return { ok: false, reason: "NOT_LINKED" };

    // Callers that already resolved the player (e.g. the ranks dashboard, which
    // just wrote the group node against this uuid) pass it in; everyone else
    // resolves it here. Never fall back to the raw users.uuid — see
    // resolveLuckPermsUuid() for why a placeholder row's uuid is not a player.
    const uuid = luckPermsUuid
      ? normalizeUuid(luckPermsUuid)
      : await resolveLuckPermsUuid(webUser);

    // Bailing out here is what stops an unresolvable uuid from looking like
    // "they hold no ranks" and stripping every rank role they have.
    if (!uuid) return { ok: false, reason: "NO_LUCKPERMS_PLAYER", discordId: webUser.discordId };

    const member = await fetchGuildMember(webUser.discordId);
    if (!member) return { ok: false, reason: "MEMBER_NOT_IN_GUILD", discordId: webUser.discordId };

    const [trackedRoleIds, shouldHaveRoleIds] = await Promise.all([
      getTrackedRoleIds(),
      getUserRoleIdsByUuid(uuid),
    ]);

    const currentRoleIds = [...member.roles.cache.keys()];
    const { toAdd, toRemove } = diffTrackedRoles(currentRoleIds, shouldHaveRoleIds, trackedRoleIds);

    if (toAdd.length) await member.roles.add(toAdd);
    if (toRemove.length) await member.roles.remove(toRemove);

    return { ok: true, toAdd, toRemove, shouldHaveRoleIds, trackedRoleIds };
  } catch (error) {
    console.error(`[rankRoleSync] Failed to sync roles for userId ${userId}:`, error.message);
    return { ok: false, reason: "ERROR", error: error.message };
  }
}

/**
 * Removes every tracked rank role from the given Discord user. Used when a
 * Discord account is unlinked, since we can no longer resolve their ranks.
 */
export async function stripAllTrackedRankRoles(discordId) {
  if (!features.ranks || !discordId) return;

  try {
    const member = await fetchGuildMember(discordId);
    if (!member) return;

    const trackedRoleIds = await getTrackedRoleIds();
    const currentRoleIds = [...member.roles.cache.keys()];
    const toRemove = currentRoleIds.filter((id) => trackedRoleIds.includes(id));

    if (toRemove.length) await member.roles.remove(toRemove);
  } catch (error) {
    console.error(`[rankRoleSync] Failed to strip roles for discordId ${discordId}:`, error.message);
  }
}

/**
 * Turns a `syncMemberRankRoles()` result into something a human can act on.
 *
 * Every failure mode in here is silent by design (the sync never throws, so a
 * rank change still succeeds when Discord is unreachable) — which is exactly
 * why callers must report the outcome rather than assume success. Used by the
 * ranks dashboard and /forcelink.
 *
 * @param result the object returned by syncMemberRankRoles()
 * @param mentionRoles render role IDs as Discord mentions (`<@&id>`) instead of raw IDs
 * @returns {{ok: boolean, level: "success"|"info"|"warning", message: string}}
 */
export function describeRankRoleSync(result, { mentionRoles = false } = {}) {
  const renderRole = (id) => (mentionRoles ? `<@&${id}>` : id);

  if (!result?.ok) {
    const reasons = {
      FEATURE_DISABLED: "the `ranks` feature flag is disabled.",
      NO_USER_ID: "they have no website account, so there is no linked Discord account to sync.",
      NOT_LINKED: "no Discord account is linked to their website account.",
      NO_LUCKPERMS_PLAYER:
        "their website account could not be matched to a LuckPerms player, so their ranks are unknown " +
        "(a placeholder account created from Discord carries a random UUID, not their Minecraft one).",
      MEMBER_NOT_IN_GUILD: "they are not a member of the configured Discord server.",
      ERROR:
        `an error occurred (${result?.error ?? "unknown"}) — check that the bot has Manage Roles ` +
        "and that its highest role sits above every rank-mapped role.",
    };

    return {
      ok: false,
      level: "warning",
      message: `No Discord roles were changed because ${reasons[result?.reason] ?? "of an unknown reason."}`,
    };
  }

  if (!result.toAdd.length && !result.toRemove.length) {
    return {
      ok: true,
      level: "info",
      message: result.shouldHaveRoleIds.length
        ? "Their Discord roles already matched their ranks — nothing to change."
        : "No rank-mapped Discord role is configured for their current rank(s) (`meta.discordid` is not set on the rank in LuckPerms), so nothing was assigned.",
    };
  }

  const parts = [];
  if (result.toAdd.length) parts.push(`Added: ${result.toAdd.map(renderRole).join(", ")}`);
  if (result.toRemove.length) parts.push(`Removed: ${result.toRemove.map(renderRole).join(", ")}`);

  return { ok: true, level: "success", message: parts.join("\n") };
}
