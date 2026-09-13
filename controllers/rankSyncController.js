/**
 * controllers/rankSyncController.js
 *
 * Makes rank changes take effect immediately, without the player relogging.
 *
 * zander-web edits LuckPerms by writing straight into its SQL tables, which LuckPerms never sees:
 * every server keeps its cached copy of a player until they reconnect. Two caches need telling:
 *
 *  1. Minecraft servers. LuckPerms' SQL messaging service (`messaging-service: sql`, or the default
 *     `auto` with MySQL/MariaDB storage) polls `luckperms_messenger` about once a second. Inserting a
 *     message there is exactly what `/lp` does after an edit, so every server reloads the affected
 *     user ("userupdate") or re-syncs all groups and users ("update").
 *
 *  2. Website sessions, which cache permissions at login. Invalidations are recorded here and
 *     checked by the session refresh hook in routes/dashboard/index.js.
 */

import { randomUUID } from "node:crypto";
import { luckpermsDb } from "./databaseController.js";

const MESSENGER_TABLE = "luckperms_messenger";

/** Hex UUID -> last time that user's ranks changed, in epoch ms. */
const userInvalidations = new Map();
/**
 * Sessions re-check their permissions at least this often anyway (see routes/dashboard/index.js),
 * so older invalidations can be forgotten.
 */
const INVALIDATION_TTL_MS = 10 * 60 * 1000;
/** Last time a change affected everyone (e.g. a group's meta was edited). */
let globalInvalidatedAt = 0;

let warnedMissingTable = false;

export function normaliseUuid(uuid) {
  if (!uuid) return null;
  const hex = String(uuid).replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

function dashedUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The JSON LuckPerms' messaging service expects, as produced by LuckPermsMessagingService. */
export function encodeLuckPermsMessage(type, content) {
  const message = { id: randomUUID(), type };
  if (content) message.content = content;
  return JSON.stringify(message);
}

function insertMessage(json) {
  return new Promise((resolve) => {
    luckpermsDb.query(
      `INSERT INTO ${MESSENGER_TABLE} (time, msg) VALUES (NOW(), ?)`,
      [json],
      (error) => {
        if (!error) return resolve(true);

        if (error.code === "ER_NO_SUCH_TABLE") {
          if (!warnedMissingTable) {
            warnedMissingTable = true;
            console.warn(
              `[RANKSYNC] ${MESSENGER_TABLE} does not exist, so rank changes will not reach online players ` +
                "until they relog. Set LuckPerms `messaging-service` to `sql` (or `auto` with MySQL storage) on every server."
            );
          }
        } else {
          console.error(`[RANKSYNC] Failed to notify LuckPerms: ${error.message}`);
        }
        resolve(false);
      }
    );
  });
}

/**
 * A player's ranks or permissions changed. Reloads them on every server and refreshes their website
 * session on its next request.
 *
 * @returns whether LuckPerms was notified; website sessions are invalidated either way
 */
export async function syncUserRanks(uuid) {
  const hex = normaliseUuid(uuid);
  if (!hex) return false;

  const now = Date.now();
  for (const [key, changedAt] of userInvalidations) {
    if (now - changedAt > INVALIDATION_TTL_MS) userInvalidations.delete(key);
  }
  userInvalidations.set(hex, now);
  return insertMessage(encodeLuckPermsMessage("userupdate", { userUuid: dashedUuid(hex) }));
}

/**
 * Group definitions changed. Makes every server re-sync all groups and online users, and refreshes
 * every website session on its next request.
 */
export async function syncAllRanks() {
  globalInvalidatedAt = Date.now();
  return insertMessage(encodeLuckPermsMessage("update"));
}

/** True when a session whose permissions were loaded at `refreshedAt` is out of date. */
export function isSessionPermissionsInvalidated(uuid, refreshedAt) {
  const loadedAt = Number(refreshedAt || 0);
  // >= so a change in the same millisecond as the last load still counts.
  if (globalInvalidatedAt && globalInvalidatedAt >= loadedAt) return true;
  const hex = normaliseUuid(uuid);
  const changedAt = hex ? userInvalidations.get(hex) : undefined;
  return changedAt !== undefined && changedAt >= loadedAt;
}
