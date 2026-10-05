/**
 * lib/permissions/permissionHolders.mjs
 *
 * Who holds a permission node, worked out from LuckPerms rows -- the reverse
 * of getUserPermissions() in controllers/userController.js, and following the
 * same rules so the two never disagree:
 *
 *   - a user's direct nodes count;
 *   - so do the nodes of every group they are in (`group.<name>` rows), and
 *     of every group those groups inherit, transitively;
 *   - their primary group counts only when they have no `group.*` rows;
 *   - wildcards (`*`, `zander.web.*`) match as in lib/discord/permissions.mjs.
 *
 * Callers pass rows already filtered to `value = 1` and unexpired.
 * No DB imports, so it is unit-testable.
 */

import { hasPermission } from "../discord/permissions.mjs";

/** LuckPerms UUIDs in one comparable form: no dashes, lowercase. */
export function normaliseUuid(uuid) {
  return String(uuid ?? "").replace(/-/g, "").trim().toLowerCase();
}

/**
 * The groups that grant `node`, themselves or through a group they inherit.
 *
 * @param {string} node
 * @param {Array<{ name: string, permission: string }>} groupPermissions
 * @returns {Set<string>} lowercased group names
 */
export function findGrantingGroups(node, groupPermissions = []) {
  const groups = new Map();
  const groupOf = (name) => {
    const key = String(name).toLowerCase();
    if (!groups.has(key)) groups.set(key, { nodes: [], parents: [] });
    return groups.get(key);
  };
  for (const { name, permission } of groupPermissions) {
    if (!name || !permission) continue;
    const group = groupOf(name);
    if (permission.startsWith("group.")) {
      const parent = permission.slice("group.".length).trim().toLowerCase();
      if (parent && parent !== String(name).toLowerCase()) group.parents.push(parent);
    } else {
      group.nodes.push(permission);
    }
  }

  const memo = new Map();
  const grants = (key, visiting = new Set()) => {
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return false; // inheritance loop
    visiting.add(key);
    const group = groups.get(key);
    const result = Boolean(group && (hasPermission(group.nodes, node) || group.parents.some((p) => grants(p, visiting))));
    memo.set(key, result);
    return result;
  };

  return new Set([...groups.keys()].filter((key) => grants(key)));
}

/**
 * @param {string} node
 * @param {object} rows
 * @param {Array<{ name: string, permission: string }>} rows.groupPermissions
 * @param {Array<{ uuid: string, permission: string }>} rows.userPermissions
 *        Direct nodes and `group.*` rows (only those that could matter is fine).
 * @param {Array<{ uuid: string, primary_group: string }>} [rows.primaryGroups]
 * @returns {Set<string>} normalised UUIDs of everyone holding `node`
 */
export function findPermissionHolders(node, { groupPermissions = [], userPermissions = [], primaryGroups = [] }) {
  const granting = findGrantingGroups(node, groupPermissions);

  const users = new Map();
  const userOf = (uuid) => {
    const key = normaliseUuid(uuid);
    if (!users.has(key)) users.set(key, { nodes: [], groups: [] });
    return users.get(key);
  };
  for (const { uuid, permission } of userPermissions) {
    if (!uuid || !permission) continue;
    const user = userOf(uuid);
    if (permission.startsWith("group.")) user.groups.push(permission.slice("group.".length).trim().toLowerCase());
    else user.nodes.push(permission);
  }
  for (const { uuid, primary_group: primary } of primaryGroups) {
    if (!uuid || !primary) continue;
    const user = userOf(uuid);
    if (!user.groups.length) user.groups.push(String(primary).toLowerCase());
  }

  const holders = new Set();
  for (const [uuid, user] of users) {
    if (hasPermission(user.nodes, node) || user.groups.some((g) => granting.has(g))) holders.add(uuid);
  }
  return holders;
}

/**
 * The node plus every wildcard that grants it, for narrowing a query:
 * "zander.web.x" → ["*", "zander.*", "zander.web.*", "zander.web.x.*", "zander.web.x"].
 */
export function grantingNodes(node) {
  const parts = String(node).trim().toLowerCase().split(".");
  const out = ["*"];
  for (let i = 1; i <= parts.length; i++) out.push(`${parts.slice(0, i).join(".")}.*`);
  out.push(parts.join("."));
  return out;
}
