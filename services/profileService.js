import db, { luckpermsDb, punishmentsDb } from "../controllers/databaseController.js";
import { UserGetter } from "../controllers/userController.js";

const RANK_VIEW = "ranks";
const USER_RANKS_VIEW = "userRanks";
const LUCKPERMS_PLAYERS_TABLE = "luckperms_players";

function mapRankRow(row) {
  const priority =
    row.priority !== null && row.priority !== undefined && row.priority !== ""
      ? Number(row.priority)
      : null;

  const isStaff =
    row.isStaff !== null && row.isStaff !== undefined && row.isStaff !== ""
      ? Number(row.isStaff)
      : 0;
  const isDonator =
    row.isDonator !== null && row.isDonator !== undefined && row.isDonator !== ""
      ? Number(row.isDonator)
      : 0;

  return {
    rankSlug: row.rankSlug,
    displayName: row.displayName || row.rankSlug,
    priority,
    rankBadgeColour: row.rankBadgeColour || null,
    rankTextColour: row.rankTextColour || null,
    discordRoleId: row.discordRoleId || null,
    isStaff,
    isDonator,
    title: row.title || null,
  };
}

/**
 * Get user data by username
 * @param {string} username
 * @returns {Promise<Object|null>}
 */
export function getUserByUsername(username) {
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT * FROM users WHERE username = ?`,
      [username],
      (error, results) => {
        if (error) {
          console.error("[PROFILE SERVICE] Error fetching user:", error);
          return reject(error);
        }
        resolve(results?.[0] || null);
      }
    );
  });
}

/**
 * Get user ranks by username
 * @param {string} username
 * @returns {Promise<Array>}
 */
export async function getUserRanks(username) {
  if (!username) {
    return [];
  }

  try {
    // Get the user's UUID from the main DB
    const [webUser] = await new Promise((resolve, reject) => {
      db.query(
        `SELECT userId, username, uuid FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1`,
        [username.trim()],
        (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        }
      );
    });

    // Determine dashed UUID — try main DB first, then LP players table
    let dashedUuid = webUser?.uuid || null;

    if (!dashedUuid) {
      const [lpPlayer] = await new Promise((resolve, reject) => {
        luckpermsDb.query(
          `SELECT uuid FROM ${LUCKPERMS_PLAYERS_TABLE} WHERE LOWER(username) = LOWER(?) LIMIT 1`,
          [username.trim()],
          (error, results) => {
            if (error) return reject(error);
            resolve(results || []);
          }
        );
      });
      dashedUuid = lpPlayer?.uuid || null;
    }

    if (!dashedUuid) {
      return [];
    }

    const uuid = dashedUuid.toLowerCase();

    // Get user's group memberships from luckpermsDb (LP uses VARCHAR(36) dashed UUIDs)
    const groupRows = await new Promise((resolve, reject) => {
      luckpermsDb.query(
        `SELECT SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
           FROM luckperms_user_permissions
          WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1`,
        [uuid],
        (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        }
      );
    });

    const groups = groupRows.map((r) => r.rankSlug);
    if (groups.length === 0) return [];

    // Get per-group title from user permissions
    // Permission format: meta.group.{rankSlug}.title.{titleValue}
    const titleRows = await new Promise((resolve, reject) => {
      luckpermsDb.query(
        `SELECT permission FROM luckperms_user_permissions
          WHERE uuid = ? AND permission LIKE 'meta.group.%.title.%' AND value = 1`,
        [uuid],
        (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        }
      );
    });

    const titleByGroup = {};
    for (const row of titleRows) {
      // e.g. "meta.group.contentcreator.title.Content Creator"
      const match = row.permission.match(/^meta\.group\.(.+?)\.title\.(.+)$/);
      if (match) titleByGroup[match[1]] = match[2];
    }

    // Get rank metadata from luckperms_group_permissions for all groups at once
    const ph = groups.map(() => "?").join(", ");
    const metaRows = await new Promise((resolve, reject) => {
      luckpermsDb.query(
        `SELECT name, permission FROM luckperms_group_permissions
          WHERE name IN (${ph})
            AND (
              permission LIKE 'displayname.%'
              OR permission LIKE 'weight.%'
              OR permission LIKE 'prefix.%'
              OR permission LIKE 'meta.rankbadgecolour.%'
              OR permission LIKE 'meta.ranktextcolour.%'
              OR permission LIKE 'meta.discordid.%'
              OR permission LIKE 'meta.staff.%'
              OR permission LIKE 'meta.donator.%'
            )
            AND value = 1`,
        groups,
        (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        }
      );
    });

    // Prefix colour code → hex (matches logic in the ranks VIEW)
    const prefixColourMap = {
      "0": "#000000", "1": "#0000AA", "2": "#00AA00", "3": "#00AAAA",
      "4": "#AA0000", "5": "#AA00AA", "6": "#FFAA00", "7": "#AAAAAA",
      "8": "#555555", "9": "#5555FF", "a": "#55FF55", "b": "#55FFFF",
      "c": "#FF5555", "d": "#FF55FF", "e": "#FFFF55", "g": "#DDD605",
    };
    const darkPrefixCodes = new Set(["0","1","2","3","4","5","8","9"]);

    const rankMeta = {};
    for (const row of metaRows) {
      const m = rankMeta[row.name] || (rankMeta[row.name] = {});
      const p = row.permission;
      if (p.startsWith("displayname.")) {
        m.displayName = p.slice("displayname.".length);
      } else if (p.startsWith("weight.")) {
        m.priority = parseInt(p.slice("weight.".length), 10) || null;
      } else if (p.startsWith("prefix.")) {
        m.prefix = p;
      } else if (p.startsWith("meta.rankbadgecolour.")) {
        m.rankBadgeColour = "#" + p.slice("meta.rankbadgecolour.".length);
      } else if (p.startsWith("meta.ranktextcolour.")) {
        m.rankTextColour = "#" + p.slice("meta.ranktextcolour.".length);
      } else if (p.startsWith("meta.discordid.")) {
        m.discordRoleId = p.slice("meta.discordid.".length);
      } else if (p.startsWith("meta.staff.")) {
        m.isStaff = parseInt(p.slice("meta.staff.".length), 10) || 0;
      } else if (p.startsWith("meta.donator.")) {
        m.isDonator = parseInt(p.slice("meta.donator.".length), 10) || 0;
      }
    }

    // Derive badge/text colour fallbacks from prefix when explicit meta is absent
    for (const rankSlug of groups) {
      const m = rankMeta[rankSlug] || (rankMeta[rankSlug] = {});
      if (!m.rankBadgeColour && m.prefix) {
        const code = m.prefix.match(/\[&(.)/)?.[1] || "";
        m.rankBadgeColour = prefixColourMap[code] || "#FFFFFF";
      }
      if (!m.rankTextColour && m.prefix) {
        const code = m.prefix.match(/\[&(.)/)?.[1] || "";
        m.rankTextColour = darkPrefixCodes.has(code) ? "#FFFFFF" : "#000000";
      }
    }

    return groups.filter((rankSlug) => rankSlug !== "default").map((rankSlug) => {
      const m = rankMeta[rankSlug] || {};
      return mapRankRow({
        rankSlug,
        displayName: m.displayName || rankSlug,
        priority: m.priority ?? null,
        rankBadgeColour: m.rankBadgeColour || null,
        rankTextColour: m.rankTextColour || null,
        discordRoleId: m.discordRoleId || null,
        isStaff: m.isStaff || 0,
        isDonator: m.isDonator || 0,
        title: titleByGroup[rankSlug] || null,
      });
    });
  } catch (error) {
    console.error("[PROFILE SERVICE] Failed to fetch ranks for", username, error);
    return [];
  }
}

/**
 * Get reports by reporter ID
 * @param {number} reporterId
 * @returns {Promise<{success: boolean, data?: Array, message?: string}>}
 */
export function getReportsByReporterId(reporterId) {
  return new Promise((resolve) => {
    db.query(
      `SELECT * FROM reports WHERE reporterId = ?`,
      [reporterId],
      (error, results) => {
        if (error) {
          console.error("[PROFILE SERVICE] Error fetching reports:", error);
          return resolve({ success: false, message: `${error}` });
        }
        if (!results || !results.length) {
          return resolve({ success: false, message: "There are no reports available." });
        }
        resolve({ success: true, data: results });
      }
    );
  });
}

/**
 * Get punishments for a user by username
 * @param {string} username
 * @returns {Promise<{success: boolean, data?: Array, message?: string}>}
 */
export async function getUserPunishments(username) {
  try {
    const userGetter = new UserGetter();
    const userRecord = await userGetter.byUsername(username);

    if (!userRecord?.uuid) {
      return { success: false, message: "User not found." };
    }

    // Query litebans tables directly on the dedicated punishments DB instance.
    // UUIDs in litebans may be stored without dashes; REPLACE normalises both sides.
    const normalizedUuid = userRecord.uuid.replace(/-/g, "").toLowerCase();
    const rawPunishments = await new Promise((resolve, reject) => {
      punishmentsDb.query(
        `SELECT litebans.id AS punishmentId,
                litebans.uuid AS bannedUuid,
                litebans.banned_by_uuid AS bannedByUuid,
                litebans.removed_by_uuid AS removedByUuid,
                litebans.type,
                litebans.active,
                litebans.silent,
                FROM_UNIXTIME(litebans.time / 1000) AS dateStart,
                FROM_UNIXTIME(NULLIF(litebans.until / 1000, 0)) AS dateEnd,
                litebans.removed_by_date AS dateRemoved,
                litebans.reason,
                litebans.removed_by_reason AS reasonRemoved,
                litebans.ip,
                litebans.ipban,
                litebans.ipban_wildcard AS ipBanWildcard
         FROM (
           SELECT id, uuid, ip, reason, banned_by_uuid, time,
                  NULL AS until, NULL AS removed_by_uuid, NULL AS removed_by_reason,
                  NULL AS removed_by_date, silent, ipban, ipban_wildcard, NULL AS active,
                  'kick' AS type FROM litebans_kicks
           UNION ALL
           SELECT id, uuid, ip, reason, banned_by_uuid, time,
                  until, removed_by_uuid, removed_by_reason, removed_by_date,
                  silent, ipban, ipban_wildcard, active, 'ban' AS type FROM litebans_bans
           UNION ALL
           SELECT id, uuid, ip, reason, banned_by_uuid, time,
                  until, removed_by_uuid, removed_by_reason, removed_by_date,
                  silent, ipban, ipban_wildcard, active, 'mute' AS type FROM litebans_mutes
           UNION ALL
           SELECT id, uuid, ip, reason, banned_by_uuid, time,
                  until, removed_by_uuid, removed_by_reason, removed_by_date,
                  silent, ipban, ipban_wildcard, active, 'warning' AS type FROM litebans_warnings
         ) AS litebans
         WHERE REPLACE(litebans.uuid, '-', '') = ?
         ORDER BY litebans.time DESC
         LIMIT 50`,
        [normalizedUuid],
        (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        }
      );
    });

    // Resolve banner/remover UUIDs → usernames from the main DB in one query.
    const actorUuids = [...new Set(
      rawPunishments.flatMap((p) => [p.bannedByUuid, p.removedByUuid].filter(Boolean))
    )];
    let usernameByUuid = {};
    if (actorUuids.length > 0) {
      const placeholders = actorUuids.map(() => "REPLACE(uuid, '-', '') = ?").join(" OR ");
      const normalized = actorUuids.map((u) => u.replace(/-/g, "").toLowerCase());
      const usersRows = await new Promise((resolve, reject) => {
        db.query(
          `SELECT uuid, username FROM users WHERE ${placeholders}`,
          normalized,
          (err, rows) => { if (err) return reject(err); resolve(rows || []); }
        );
      });
      for (const row of usersRows) {
        usernameByUuid[row.uuid.replace(/-/g, "").toLowerCase()] = row.username;
      }
    }

    const punishments = rawPunishments.map((p) => ({
      ...p,
      bannedByUsername: p.bannedByUuid
        ? usernameByUuid[p.bannedByUuid.replace(/-/g, "").toLowerCase()] || null
        : null,
      removedByUsername: p.removedByUuid
        ? usernameByUuid[p.removedByUuid.replace(/-/g, "").toLowerCase()] || null
        : null,
    }));

    return {
      success: true,
      data: punishments,
      target: {
        username: userRecord.username,
        uuid: userRecord.uuid,
        userId: userRecord.userId,
      },
    };
  } catch (error) {
    console.error("[PROFILE SERVICE] Failed to fetch punishments:", error);
    return { success: false, message: `${error}` };
  }
}
