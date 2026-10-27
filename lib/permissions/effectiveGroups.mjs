/**
 * lib/permissions/effectiveGroups.mjs
 *
 * Resolves a user's EFFECTIVE LuckPerms groups exactly as the Compass brief
 * defines "groups":
 *
 *   - inherited groups INCLUDED (transitively, via group → group parents)
 *   - GLOBAL CONTEXT ONLY  (server = 'global' AND world = 'global')
 *   - NON-EXPIRING ONLY    (expiry IS NULL / 0 / in the future) and value = 1
 *
 * This is deliberately separate from controllers/userController.js
 * `getUserPermissions` / `getUserRanks`, which resolve PERMISSION NODES and do
 * NOT filter by context. Compass needs group SLUGS under the global context
 * only, so this module applies the `server='global' AND world='global'` scope
 * the write/sync paths already use (api/routes/ranks.js, lib/discord/rankRoleSync.mjs).
 *
 * The inheritance walk is factored into a pure function (`expandGroups`) so it
 * can be unit-tested without a database. `getEffectiveGroups` wires it to
 * LuckPerms via an injectable `query` function (defaults to the real pool).
 */

// The database handles are imported lazily (inside the query helpers) rather
// than at module top, so this module — and its pure functions — can be imported
// in unit tests without opening a connection pool or needing DATABASE_URL set.

const USER_PERMISSIONS = "luckperms_user_permissions";
const GROUP_PERMISSIONS = "luckperms_group_permissions";
const PLAYERS = "luckperms_players";

// Shared predicate for "this grant is active right now": it is a positive grant
// (value = 1), it has not expired, and it applies in the global context — not a
// server=events / world=nether contextual override.
const GLOBAL_ACTIVE =
  "value = 1 AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP()) " +
  "AND server = 'global' AND world = 'global'";

let _dbModule = null;
async function dbModule() {
  if (!_dbModule) _dbModule = await import("../../controllers/databaseController.js");
  return _dbModule;
}

async function runLuckPermsQuery(query, params = []) {
  const { luckpermsDb } = await dbModule();
  return new Promise((resolve, reject) => {
    luckpermsDb.query(query, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

async function runMainQuery(query, params = []) {
  const { default: db } = await dbModule();
  return new Promise((resolve, reject) => {
    db.query(query, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

/**
 * Transitively expand a set of directly-held group slugs into the full
 * effective set, following `group.<parent>` rows from the group table.
 *
 * Pure and synchronous-in-shape: `getParents(slugs)` returns, for the given
 * batch of groups, the parent group slugs inherited by any of them. The walk is
 * breadth-first and loop-guarded, so a cycle (a → b → a) terminates.
 *
 * @param {string[]} directGroups
 * @param {(slugs: string[]) => Promise<string[]>} getParents
 * @returns {Promise<string[]>} every effective group slug, de-duplicated
 */
export async function expandGroups(directGroups, getParents) {
  const effective = new Set();
  let frontier = [];

  for (const slug of directGroups) {
    const norm = normaliseSlug(slug);
    if (norm && !effective.has(norm)) {
      effective.add(norm);
      frontier.push(norm);
    }
  }

  while (frontier.length) {
    const parents = await getParents(frontier);
    const next = [];
    for (const parent of parents) {
      const norm = normaliseSlug(parent);
      if (norm && !effective.has(norm)) {
        effective.add(norm);
        next.push(norm);
      }
    }
    frontier = next;
  }

  return Array.from(effective);
}

function normaliseSlug(slug) {
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

/**
 * Resolve the live effective groups for a user. Accepts whatever identity we
 * have — a LuckPerms UUID (preferred), a Zander userId, and/or a username — and
 * resolves a UUID the same way userController does (users table, then the
 * LuckPerms players table by username).
 *
 * @param {{uuid?: string, userId?: number, username?: string}} identity
 * @param {{query?: Function, mainQuery?: Function}} [deps] test seams
 * @returns {Promise<string[]>} effective group slugs (lowercased), or [] if none / no UUID
 */
export async function getEffectiveGroups(identity = {}, deps = {}) {
  const query = deps.query || runLuckPermsQuery;
  const mainQuery = deps.mainQuery || runMainQuery;

  const uuid = await resolveUuid(identity, { query, mainQuery });
  if (!uuid) return [];

  // 1. Directly-assigned groups (global, active).
  const directRows = await query(
    `SELECT SUBSTRING_INDEX(permission, '.', -1) AS slug
       FROM ${USER_PERMISSIONS}
      WHERE uuid = ?
        AND permission LIKE 'group.%'
        AND ${GLOBAL_ACTIVE}`,
    [uuid]
  );
  let direct = directRows.map((r) => r.slug).filter(Boolean);

  // 2. Primary-group fallback — only when the user holds no explicit group row,
  //    matching LuckPerms' own semantics (a user always has a primary group).
  if (!direct.length) {
    const primaryRows = await query(
      `SELECT primary_group AS slug FROM ${PLAYERS} WHERE uuid = ? LIMIT 1`,
      [uuid]
    );
    direct = primaryRows.map((r) => r.slug).filter(Boolean);
  }

  if (!direct.length) return [];

  // 3. Walk inheritance (group → parent group).
  const getParents = async (slugs) => {
    const placeholders = slugs.map(() => "?").join(", ");
    const rows = await query(
      `SELECT SUBSTRING_INDEX(permission, '.', -1) AS parent
         FROM ${GROUP_PERMISSIONS}
        WHERE name IN (${placeholders})
          AND permission LIKE 'group.%'
          AND ${GLOBAL_ACTIVE}`,
      slugs
    );
    return rows.map((r) => r.parent).filter(Boolean);
  };

  const effective = await expandGroups(direct, getParents);
  effective.sort();
  return effective;
}

async function resolveUuid(identity, { query, mainQuery }) {
  if (identity.uuid) return identity.uuid;

  if (identity.userId != null) {
    const rows = await mainQuery(`SELECT uuid FROM users WHERE userId = ? LIMIT 1`, [
      identity.userId,
    ]);
    if (rows.length && rows[0].uuid) return rows[0].uuid;
  }

  if (identity.username) {
    const rows = await query(
      `SELECT uuid FROM ${PLAYERS} WHERE LOWER(username) = LOWER(?) LIMIT 1`,
      [identity.username]
    );
    if (rows.length && rows[0].uuid) return rows[0].uuid;
  }

  return null;
}

/**
 * True when the user holds at least one of the configured staff groups. The
 * staff group list is CONFIGURATION (config.compass.staffGroups), never code —
 * see lib/config/defaults.cjs. Comparison is case-insensitive.
 *
 * @param {string[]} effectiveGroups
 * @param {string[]} staffGroups
 */
export function isStaff(effectiveGroups, staffGroups) {
  if (!Array.isArray(effectiveGroups) || !Array.isArray(staffGroups)) return false;
  const staff = new Set(staffGroups.map((g) => String(g).trim().toLowerCase()).filter(Boolean));
  return effectiveGroups.some((g) => staff.has(String(g).trim().toLowerCase()));
}
