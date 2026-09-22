/**
 * controllers/rankPermissionController.js
 *
 * Reading and changing the Zander permissions held by a LuckPerms group.
 *
 * Reads come straight from the LuckPerms database. Writes deliberately do NOT:
 * LuckPerms keeps its permissions in memory, so a row inserted behind its back
 * does nothing until the server is reloaded, and would look applied in the
 * dashboard while having no effect in game. Changes are queued as console
 * commands for zander-addon instead -- the same route the webstore and the
 * birthday rank use -- so LuckPerms applies and propagates them itself.
 *
 * Only nodes in lib/permissions/zanderNodes.mjs are ever written. A group holds
 * far more than Zander's nodes, and none of the rest is this screen's business.
 */

import db, { luckpermsDb } from "./databaseController.js";
import { isGrantableNode, partitionHeldNodes } from "../lib/permissions/zanderNodes.mjs";

const luckperms = (sql, params = []) =>
  new Promise((resolve, reject) => {
    luckpermsDb.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });

const main = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });

/**
 * What this group currently holds, split into what the checklist manages and
 * what it must leave alone.
 *
 * Negative permissions (`value = 0`) are excluded from `known`: LuckPerms uses
 * them to explicitly deny something, and showing a denial as a tick would be
 * exactly backwards.
 */
export async function getRankPermissions(rankSlug) {
  const rows = await luckperms(
    `SELECT permission, value
       FROM luckperms_group_permissions
      WHERE name = ?
        AND (permission LIKE 'zander.%' OR permission = '*')`,
    [String(rankSlug)]
  );

  const granted = rows.filter((r) => Number(r.value) === 1).map((r) => r.permission);
  const denied = rows.filter((r) => Number(r.value) !== 1).map((r) => r.permission);

  const { known, unmanaged } = partitionHeldNodes(granted);
  return { known, unmanaged, denied };
}

/**
 * Work out the difference between what a group holds and what was ticked.
 *
 * Returns only the nodes that actually change, so saving a form nobody edited
 * queues nothing at all.
 *
 * Everything on both sides is filtered through the allow-list, so a
 * hand-crafted POST cannot smuggle in `*` or another plugin's node.
 */
export function diffPermissions(current = [], wanted = []) {
  const held = new Set(current.filter(isGrantableNode));
  const ticked = new Set(wanted.filter(isGrantableNode));

  return {
    grant: [...ticked].filter((node) => !held.has(node)).sort(),
    revoke: [...held].filter((node) => !ticked.has(node)).sort(),
  };
}

/**
 * Queue the changes as LuckPerms console commands.
 *
 * `permission set <node> true` and `permission unset <node>` are idempotent, so
 * a task retried by the executor cannot do damage.
 *
 * Returns the number of commands queued.
 */
export async function applyRankPermissions(rankSlug, { grant = [], revoke = [] }, actor = null) {
  const slug = String(rankSlug).trim();
  if (!slug) throw new Error("A rank is required.");

  const commands = [
    ...grant.filter(isGrantableNode).map((node) => `lp group ${slug} permission set ${node} true`),
    ...revoke.filter(isGrantableNode).map((node) => `lp group ${slug} permission unset ${node}`),
  ];

  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop
    await main(
      `INSERT INTO executorTasks (slug, command, status, priority, metadata, createdAt, updatedAt)
       VALUES ('any', ?, 'pending', 5, ?, NOW(), NOW())`,
      [command, JSON.stringify({ source: "rankPermissions", rankSlug: slug, actor })]
    );
  }

  return commands.length;
}
