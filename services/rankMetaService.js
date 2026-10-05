/**
 * services/rankMetaService.js
 *
 * Read-only lookup of LuckPerms group metadata (display name, weight, donator
 * flag) for callers that need to *describe* a rank rather than administer one.
 *
 * api/routes/ranks.js builds the same map inside a route closure, but it is
 * wrapped in the ranks feature flag and the rank-admin permission, so the
 * public events pages cannot reuse it.  This module exposes just the read
 * half, with a short cache: the events listing asks for it on every page
 * render and LuckPerms group metadata changes about once a quarter.
 */

import { luckpermsDb } from "../controllers/databaseController.js";

const LUCKPERMS_GROUP_PERMISSIONS_TABLE = "luckperms_group_permissions";

/** LuckPerms group metadata changes rarely; a minute of staleness is harmless. */
const CACHE_TTL_MS = 60_000;

let cache = null;
let cachedAt = 0;
let inFlight = null;

function queryLuckPermsDb(query, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(query, params, (error, results) => {
      if (error) reject(error);
      else resolve(results || []);
    });
  });
}

async function loadRankMeta() {
  const rows = await queryLuckPermsDb(
    `SELECT name, permission FROM ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
      WHERE server = 'global' AND world = 'global'
        AND value = 1
        AND (
          permission LIKE 'displayname.%'
          OR permission LIKE 'weight.%'
          OR permission LIKE 'meta.donator.%'
          OR permission LIKE 'meta.staff.%'
          OR permission LIKE 'meta.rankbadgecolour.%'
        )`
  );

  const meta = new Map();
  for (const row of rows) {
    const slug = String(row.name || "").toLowerCase();
    if (!slug) continue;

    const entry = meta.get(slug) || { rankSlug: slug, displayName: slug };
    const p = row.permission;

    if (p.startsWith("displayname.")) {
      entry.displayName = p.slice("displayname.".length);
    } else if (p.startsWith("weight.")) {
      entry.priority = parseInt(p.slice("weight.".length), 10) || 0;
    } else if (p.startsWith("meta.donator.")) {
      entry.isDonator = (parseInt(p.slice("meta.donator.".length), 10) || 0) === 1;
    } else if (p.startsWith("meta.staff.")) {
      entry.isStaff = (parseInt(p.slice("meta.staff.".length), 10) || 0) === 1;
    } else if (p.startsWith("meta.rankbadgecolour.")) {
      entry.rankBadgeColour = "#" + p.slice("meta.rankbadgecolour.".length);
    }

    meta.set(slug, entry);
  }

  return meta;
}

/**
 * Map of lower-cased rank slug -> {rankSlug, displayName, priority, isDonator,
 * isStaff, rankBadgeColour}.
 *
 * Never throws: LuckPerms lives in a separate database this app does not own,
 * and an events page should still render (with slugs in place of display
 * names) if that database is unreachable.
 */
export async function getRankMetaMap() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

  // Collapse concurrent misses onto one query — a cold cache plus a burst of
  // page loads would otherwise fire one LuckPerms query per request.
  if (!inFlight) {
    inFlight = loadRankMeta()
      .then((meta) => {
        cache = meta;
        cachedAt = Date.now();
        return meta;
      })
      .catch((err) => {
        console.error("[RankMeta] failed to load LuckPerms group metadata:", err);
        return cache || new Map();
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

/** Slugs of every group flagged `meta.donator.1` — i.e. ranks a visitor can buy. */
export async function getDonatorRankSlugs() {
  const meta = await getRankMetaMap();
  return [...meta.values()].filter((r) => r.isDonator).map((r) => r.rankSlug);
}

/** Every group, highest weight first — used to populate the editor's rank picker. */
export async function getSelectableRanks() {
  const meta = await getRankMetaMap();
  return [...meta.values()].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.rankSlug.localeCompare(b.rankSlug)
  );
}

/** Drop the cache so a rank edit is reflected without waiting out the TTL. */
export function invalidateRankMetaCache() {
  cache = null;
  cachedAt = 0;
}

/**
 * The permission strings that would grant `node`, including wildcard ancestors.
 *
 * Mirrors the matching in permissionMatch() (controllers/forumController.js)
 * and hasPermission() (api/common.js): an exact node, a bare "*", or any
 * ancestor wildcard.  Building the list explicitly lets the lookup below use
 * an indexed IN clause instead of scanning every group permission row.
 *
 * Exported for testing -- it is the part with the fiddly edge cases.
 */
export function grantingPermissionStrings(node) {
  const target = String(node ?? "").trim().toLowerCase();
  if (!target) return [];

  const candidates = new Set([target, "*"]);

  // STRICT ancestors only -- "a.b.*" but not "a.b.c.*" for node "a.b.c".
  //
  // The two matchers in this codebase disagree about that last one.
  // permissionMatch (controllers/forumController.js) strips only the "*" and
  // tests startsWith, so "a.b.c.*" does NOT grant "a.b.c"; hasPermission
  // (api/common.js) strips ".*" and also accepts an exact base match, so
  // there it does.  Naming a rank that the forum check would still reject
  // would be worse than saying nothing, so this follows the stricter of the
  // two.  Under-reporting is the safe direction: the caller falls back to a
  // 404 rather than advertising a rank that does not actually open the door.
  const parts = target.split(".");
  for (let i = 1; i < parts.length; i++) {
    candidates.add(parts.slice(0, i).join(".") + ".*");
  }

  return [...candidates];
}

/**
 * Which LuckPerms groups grant a given permission node.
 *
 * Used to turn "you lack zander.web.forums.supporter" into "this is for
 * Supporter members, here is where to get it" -- a forum category stores a
 * permission node, but the person reading it needs a rank name.
 *
 * Returns rank metadata rows (highest weight first), never throws, and
 * returns [] for a node nothing grants.
 */
export async function getGroupsGrantingPermission(node) {
  const candidates = grantingPermissionStrings(node);
  if (candidates.length === 0) return [];

  let rows = [];
  try {
    rows = await queryLuckPermsDb(
      `SELECT DISTINCT name FROM ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
        WHERE server = 'global' AND world = 'global'
          AND value = 1
          AND permission IN (${candidates.map(() => "?").join(", ")})`,
      candidates
    );
  } catch (err) {
    // LuckPerms is a database this app does not own; a page that merely wants
    // to name a rank must not fail because that database is unreachable.
    console.error("[RankMeta] failed to resolve groups granting a permission:", err);
    return [];
  }

  const meta = await getRankMetaMap();
  return rows
    .map((row) => {
      const slug = String(row.name || "").toLowerCase();
      return meta.get(slug) || { rankSlug: slug, displayName: slug };
    })
    .filter((r) => r.rankSlug)
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        a.rankSlug.localeCompare(b.rankSlug)
    );
}
