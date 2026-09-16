/**
 * Meeting Roster Service
 *
 * Expands a set of LuckPerms rank slugs into the concrete list of website
 * users who should be invited to a meeting poll.
 *
 * LuckPerms lives on a separate MySQL server from the main app DB, so the two
 * sides cannot be joined in SQL — every lookup here queries luckpermsDb and db
 * independently and merges in JS.  This mirrors services/profileService.js
 * (getUserRanks) and lib/discord/rankRoleSync.mjs, which are the proven-working
 * references for this pattern.
 *
 * Nodes are scoped to server='global' AND world='global' so a contextual
 * override (e.g. server=events) never shadows the intended global membership,
 * matching how the dashboard's rank config editor writes them
 * (updateGroupNode() in api/routes/ranks.js).
 */

import db, { luckpermsDb } from "../controllers/databaseController.js";
import { ACCOUNT_STATE, classifyAccountState } from "../controllers/userAccountState.js";

const LUCKPERMS_USER_PERMISSIONS_TABLE = "luckperms_user_permissions";
const LUCKPERMS_PLAYERS_TABLE = "luckperms_players";
const LUCKPERMS_GROUPS_TABLE = "luckperms_groups";

/** Why an invitee cannot respond, surfaced to the organiser in the preview. */
export const INVITEE_BLOCKED_REASON = {
  PLACEHOLDER: "PLACEHOLDER",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  NO_WEBSITE_LOGIN: "NO_WEBSITE_LOGIN",
};

/** Why a rank member could not be turned into an invitee at all. */
export const UNRESOLVED_REASON = {
  NO_WEB_ACCOUNT: "NO_WEB_ACCOUNT",
};

function queryDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

function queryLuckPermsDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

/** mysql2 hands back TINYINT(1) as 0/1; Prisma hands back true/false. */
function toBool(value) {
  return Boolean(Number(value));
}

/**
 * Whether a `users` row represents someone who can actually sign in and answer
 * a poll.  A placeholder or Minecraft-only profile has no password to log in
 * with, and a disabled account is locked out — both stay on the roster with
 * canRespond = false so the organiser can see the gap rather than wondering
 * why the invitee count dropped.
 *
 * @param {object} user a `users` row
 * @returns {{canRespond: boolean, blockedReason: string|null}}
 */
export function classifyInviteeEligibility(user) {
  if (toBool(user?.is_placeholder)) {
    return { canRespond: false, blockedReason: INVITEE_BLOCKED_REASON.PLACEHOLDER };
  }
  if (toBool(user?.account_disabled)) {
    return { canRespond: false, blockedReason: INVITEE_BLOCKED_REASON.ACCOUNT_DISABLED };
  }
  if (classifyAccountState(user) !== ACCOUNT_STATE.REGISTERED) {
    return { canRespond: false, blockedReason: INVITEE_BLOCKED_REASON.NO_WEBSITE_LOGIN };
  }
  return { canRespond: true, blockedReason: null };
}

/**
 * Merge LuckPerms rank memberships against `users` rows.  Pure — no database
 * access — so the merge rules are unit-testable on their own.
 *
 * A player in two of the selected ranks yields a single invitee; `viaRankSlug`
 * records the first rank they matched in `rankSlugs` order, so the attribution
 * is stable rather than dependent on row order from LuckPerms.
 *
 * A LuckPerms uuid with no `users` row has no userId to key an invitee on, so
 * it cannot become an invitee.  Those are returned in `unresolved` rather than
 * dropped, so the organiser is told the roster is incomplete.
 *
 * @param {string[]} rankSlugs           the requested ranks, in priority order
 * @param {{uuid: string, rankSlug: string}[]} memberships  LuckPerms rows
 * @param {object[]} webUsers            matching `users` rows
 * @param {Map<string,string>} lpNames   uuid -> LuckPerms username, for unresolved
 */
export function mergeRankMembers(rankSlugs, memberships, webUsers, lpNames = new Map()) {
  const rankPriority = new Map(rankSlugs.map((slug, index) => [slug, index]));

  const usersByUuid = new Map();
  for (const user of webUsers) {
    if (user?.uuid) usersByUuid.set(String(user.uuid).toLowerCase(), user);
  }

  // Best (lowest-priority-index) rank seen per uuid.
  const bestRankByUuid = new Map();
  for (const row of memberships) {
    const uuid = String(row.uuid || "").toLowerCase();
    if (!uuid) continue;

    const priority = rankPriority.has(row.rankSlug)
      ? rankPriority.get(row.rankSlug)
      : Number.MAX_SAFE_INTEGER;

    const current = bestRankByUuid.get(uuid);
    if (!current || priority < current.priority) {
      bestRankByUuid.set(uuid, { rankSlug: row.rankSlug, priority });
    }
  }

  const invitees = [];
  const unresolved = [];

  for (const [uuid, { rankSlug }] of bestRankByUuid) {
    const user = usersByUuid.get(uuid);

    if (!user) {
      unresolved.push({
        uuid,
        username: lpNames.get(uuid) || null,
        viaRankSlug: rankSlug,
        reason: UNRESOLVED_REASON.NO_WEB_ACCOUNT,
      });
      continue;
    }

    const { canRespond, blockedReason } = classifyInviteeEligibility(user);
    invitees.push({
      userId: user.userId,
      uuid,
      username: user.username,
      source: "role",
      viaRankSlug: rankSlug,
      canRespond,
      blockedReason,
    });
  }

  invitees.sort((a, b) => (a.username || "").localeCompare(b.username || ""));
  unresolved.sort((a, b) => (a.username || "").localeCompare(b.username || ""));

  return { invitees, unresolved };
}

/**
 * Every uuid directly holding one of the given ranks, with the rank matched.
 *
 * Direct membership only: LuckPerms group inheritance (a `group.x` node on a
 * *group* rather than on a user) is deliberately not followed in this pass.
 * Adding it means a second query against luckperms_group_permissions and a
 * transitive closure before this point — mergeRankMembers is unaffected.
 */
async function fetchDirectRankMemberships(rankSlugs) {
  const placeholders = rankSlugs.map(() => "?").join(", ");
  return queryLuckPermsDb(
    `SELECT LOWER(uuid) AS uuid, SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
       FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
      WHERE permission IN (${placeholders}) AND value = 1
        AND server = 'global' AND world = 'global'
        AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
    rankSlugs.map((slug) => `group.${slug}`)
  );
}

/**
 * Expand rank slugs into the meeting roster.
 *
 * @param {string[]} rankSlugs
 * @returns {Promise<{invitees: object[], unresolved: object[]}>}
 */
export async function expandRanksToInvitees(rankSlugs) {
  const slugs = [...new Set((rankSlugs || []).map((s) => String(s || "").trim()).filter(Boolean))];
  if (slugs.length === 0) return { invitees: [], unresolved: [] };

  const memberships = await fetchDirectRankMemberships(slugs);
  const uuids = [...new Set(memberships.map((row) => String(row.uuid).toLowerCase()))];
  if (uuids.length === 0) return { invitees: [], unresolved: [] };

  const placeholders = uuids.map(() => "?").join(", ");
  const webUsers = await queryDb(
    `SELECT userId, uuid, username, email, password_hash, account_registered,
            is_placeholder, account_disabled
       FROM users
      WHERE LOWER(uuid) IN (${placeholders})`,
    uuids
  );

  // Names for the uuids with no website account, so the organiser sees who is
  // missing rather than a bare uuid.
  const knownUuids = new Set(webUsers.map((u) => String(u.uuid).toLowerCase()));
  const missingUuids = uuids.filter((uuid) => !knownUuids.has(uuid));

  const lpNames = new Map();
  if (missingUuids.length > 0) {
    const missingPlaceholders = missingUuids.map(() => "?").join(", ");
    const lpRows = await queryLuckPermsDb(
      `SELECT LOWER(uuid) AS uuid, username FROM ${LUCKPERMS_PLAYERS_TABLE}
        WHERE LOWER(uuid) IN (${missingPlaceholders})`,
      missingUuids
    );
    for (const row of lpRows) lpNames.set(row.uuid, row.username);
  }

  return mergeRankMembers(slugs, memberships, webUsers, lpNames);
}

/**
 * Every LuckPerms group, for the rank picker in the meeting editor.
 * Mirrors getRankDirectory() in api/routes/ranks.js.
 */
export async function listRankSlugs() {
  const rows = await queryLuckPermsDb(`SELECT name AS rankSlug FROM ${LUCKPERMS_GROUPS_TABLE}`);
  return rows
    .map((row) => row.rankSlug)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
