import { isFeatureEnabled, optional } from "../common.js";
import {
  UserGetter,
  getUserPermissions,
} from "../../controllers/userController.js";
import { luckpermsDb } from "../../controllers/databaseController.js";
import { syncMemberRankRoles } from "../../lib/discord/rankRoleSync.mjs";
import { syncAllRanks, syncUserRanks } from "../../controllers/rankSyncController.js";

const LUCKPERMS_PLAYERS_TABLE = "luckperms_players";
const LUCKPERMS_GROUP_PERMISSIONS_TABLE = "luckperms_group_permissions";
const LUCKPERMS_USER_PERMISSIONS_TABLE = "luckperms_user_permissions";

function parseBoolean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return false;
}

function normalizeColour(value) {
  if (!value) return null;
  let trimmed = String(value).trim().replace(/[^0-9a-fA-F#]/g, "");
  if (!trimmed) return null;

  if (trimmed.startsWith("#")) {
    trimmed = trimmed.substring(1);
  }

  if (trimmed.length === 3) {
    trimmed = trimmed
      .split("")
      .map((char) => `${char}${char}`)
      .join("");
  }

  if (trimmed.length < 6) {
    return null;
  }

  return `#${trimmed.substring(0, 6).toLowerCase()}`;
}

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
  };
}

export default function rankApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/rank";

  const queryDb = (query, params = []) => {
    return new Promise((resolve, reject) => {
      db.query(query, params, (error, results) => {
        if (error) reject(error);
        else resolve(results);
      });
    });
  };

  const queryLuckPermsDb = (query, params = []) => {
    return new Promise((resolve, reject) => {
      luckpermsDb.query(query, params, (error, results) => {
        if (error) reject(error);
        else resolve(results);
      });
    });
  };

  async function normalizeUserPermissionContexts(uuid, rankSlug = null) {
    if (!uuid) return;

    const conditions = ["uuid = ?", "contexts = '[]'"];
    const params = [uuid];

    if (rankSlug) {
      conditions.push("(permission = ? OR permission LIKE CONCAT('meta.group.', ?, '.title.%'))");
      params.push(`group.${rankSlug}`, rankSlug);
    } else {
      conditions.push("(permission LIKE 'group.%' OR permission LIKE 'meta.group.%.title.%')");
    }

    await queryLuckPermsDb(
      `UPDATE ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          SET contexts = '{}'
        WHERE ${conditions.join(" AND ")}`,
      params
    );
  }

  async function resolvePlayer(username) {
    if (!username) {
      return null;
    }

    const trimmedUsername = String(username).trim();
    if (!trimmedUsername) {
      return null;
    }

    const [webUser] = await queryDb(
      `SELECT userId, username, uuid FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1`,
      [trimmedUsername]
    );

    const [luckPermsUser] = await queryLuckPermsDb(
      `SELECT username, LOWER(uuid) AS uuid FROM ${LUCKPERMS_PLAYERS_TABLE} WHERE LOWER(username) = LOWER(?) LIMIT 1`,
      [trimmedUsername]
    );

    if (!webUser && !luckPermsUser) {
      return null;
    }

    // LuckPerms MySQL stores uuid as VARCHAR(36) with dashes — matches
    // users.uuid's own dashed format directly, no HEX()/UNHEX() needed.
    const uuid = luckPermsUser?.uuid ?? (webUser?.uuid ? webUser.uuid.toLowerCase() : null);

    return {
      userId: webUser?.userId ?? null,
      username: webUser?.username || luckPermsUser?.username || trimmedUsername,
      uuid,
    };
  }

  // LuckPerms lives on a separate MySQL server from the main app DB, so it
  // cannot be joined via a cross-database SQL view (the `ranks`/`userRanks`
  // views this file used to rely on) — every rank lookup below queries
  // luckpermsDb and db independently and merges in JS, mirroring the
  // proven-working pattern in services/profileService.js:getUserRanks.
  // Nodes are read scoped to server='global'/world='global' to match what
  // updateGroupNode() (below) writes.

  const PREFIX_COLOUR_MAP = {
    "0": "#000000", "1": "#0000AA", "2": "#00AA00", "3": "#00AAAA",
    "4": "#AA0000", "5": "#AA00AA", "6": "#FFAA00", "7": "#AAAAAA",
    "8": "#555555", "9": "#5555FF", "a": "#55FF55", "b": "#55FFFF",
    "c": "#FF5555", "d": "#FF55FF", "e": "#FFFF55", "g": "#DDD605",
  };
  const DARK_PREFIX_CODES = new Set(["0", "1", "2", "3", "4", "5", "8", "9"]);

  /** Map of rankSlug -> {displayName, priority, rankBadgeColour, rankTextColour, discordRoleId, isStaff, isDonator} for every LuckPerms group. */
  async function getRankMetaMap() {
    const rows = await queryLuckPermsDb(
      `SELECT name, permission FROM ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
        WHERE server = 'global' AND world = 'global'
          AND value = 1
          AND (
            permission LIKE 'displayname.%'
            OR permission LIKE 'weight.%'
            OR permission LIKE 'prefix.%'
            OR permission LIKE 'meta.rankbadgecolour.%'
            OR permission LIKE 'meta.ranktextcolour.%'
            OR permission LIKE 'meta.discordid.%'
            OR permission LIKE 'meta.staff.%'
            OR permission LIKE 'meta.donator.%'
          )`
    );

    const meta = new Map();
    for (const row of rows) {
      const m = meta.get(row.name) || {};
      const p = row.permission;
      if (p.startsWith("displayname.")) m.displayName = p.slice("displayname.".length);
      else if (p.startsWith("weight.")) m.priority = parseInt(p.slice("weight.".length), 10) || null;
      else if (p.startsWith("prefix.")) m.prefix = p;
      else if (p.startsWith("meta.rankbadgecolour.")) m.rankBadgeColour = "#" + p.slice("meta.rankbadgecolour.".length);
      else if (p.startsWith("meta.ranktextcolour.")) m.rankTextColour = "#" + p.slice("meta.ranktextcolour.".length);
      else if (p.startsWith("meta.discordid.")) m.discordRoleId = p.slice("meta.discordid.".length);
      else if (p.startsWith("meta.staff.")) m.isStaff = parseInt(p.slice("meta.staff.".length), 10) || 0;
      else if (p.startsWith("meta.donator.")) m.isDonator = parseInt(p.slice("meta.donator.".length), 10) || 0;
      meta.set(row.name, m);
    }

    // Derive badge/text colour fallbacks from prefix when explicit meta is absent
    for (const m of meta.values()) {
      if (!m.rankBadgeColour && m.prefix) {
        const code = m.prefix.match(/\[&(.)/)?.[1] || "";
        m.rankBadgeColour = PREFIX_COLOUR_MAP[code] || "#FFFFFF";
      }
      if (!m.rankTextColour && m.prefix) {
        const code = m.prefix.match(/\[&(.)/)?.[1] || "";
        m.rankTextColour = DARK_PREFIX_CODES.has(code) ? "#FFFFFF" : "#000000";
      }
    }

    return meta;
  }

  function rankRowFromMeta(rankSlug, metaMap) {
    const m = metaMap.get(rankSlug) || {};
    return mapRankRow({
      rankSlug,
      displayName: m.displayName || rankSlug,
      priority: m.priority ?? null,
      rankBadgeColour: m.rankBadgeColour || null,
      rankTextColour: m.rankTextColour || null,
      discordRoleId: m.discordRoleId || null,
      isStaff: m.isStaff || 0,
      isDonator: m.isDonator || 0,
    });
  }

  function sortRankRows(rows) {
    return [...rows].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.rankSlug.localeCompare(b.rankSlug)
    );
  }

  /** Every rank (with title and expiry, if set) the given LuckPerms player uuid directly holds. */
  async function getRanksForUuid(uuid) {
    const groupRows = await queryLuckPermsDb(
      `SELECT SUBSTRING_INDEX(permission, '.', -1) AS rankSlug, expiry
         FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
        WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1
          AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
      [uuid]
    );
    if (!groupRows.length) return [];
    const expiresAtByRank = {};
    for (const row of groupRows) {
      expiresAtByRank[row.rankSlug] = row.expiry ? row.expiry * 1000 : null;
    }
    const rankSlugs = groupRows.map((r) => r.rankSlug);

    const titleRows = await queryLuckPermsDb(
      `SELECT permission FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
        WHERE uuid = ? AND permission LIKE 'meta.group.%.title.%' AND value = 1`,
      [uuid]
    );
    const titleByGroup = {};
    for (const row of titleRows) {
      const match = row.permission.match(/^meta\.group\.(.+?)\.title\.(.+)$/);
      if (match) titleByGroup[match[1]] = match[2];
    }

    const metaMap = await getRankMetaMap();
    return sortRankRows(
      rankSlugs.map((rankSlug) => ({
        ...rankRowFromMeta(rankSlug, metaMap),
        title: titleByGroup[rankSlug] || null,
        expiresAt: expiresAtByRank[rankSlug] ?? null,
      }))
    );
  }

  function permissionMatch(permissions, node) {
    if (!Array.isArray(permissions) || !node) {
      return false;
    }

    const requested = node.trim();
    if (!requested) {
      return false;
    }

    return permissions.some((permission) => {
      if (!permission) return false;
      if (permission === "*") return true;
      if (permission === requested) return true;
      if (permission.endsWith(".*")) {
        const base = permission.slice(0, -1);
        return requested.startsWith(base);
      }
      return false;
    });
  }

  async function updateGroupNode(rankSlug, key, rawValue) {
    const trimmedValue =
      rawValue === null || rawValue === undefined
        ? null
        : String(rawValue).trim();

    const effectiveValue = trimmedValue === "" ? null : trimmedValue;

    await queryLuckPermsDb(
      `DELETE FROM ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
        WHERE name = ?
          AND permission LIKE ?
          AND server = 'global'
          AND world = 'global'`,
      [rankSlug, `${key}.%`]
    );

    if (effectiveValue === null) {
      return;
    }

    await queryLuckPermsDb(
      `INSERT INTO ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
        (name, permission, value, server, world, expiry, contexts)
      VALUES (?, ?, 1, 'global', 'global', 0, '{}')`,
      [rankSlug, `${key}.${effectiveValue}`]
    );
  }

  async function getRankDirectory() {
    const groupRows = await queryLuckPermsDb(`SELECT name AS rankSlug FROM luckperms_groups`);
    const metaMap = await getRankMetaMap();
    return sortRankRows(groupRows.map((g) => rankRowFromMeta(g.rankSlug, metaMap)));
  }

  app.get(`${baseEndpoint}/get`, async function (req, res) {
    if (!isFeatureEnabled(features.ranks, res, lang)) return;
    const username = optional(req.query, "username");
    const rankSlug = optional(req.query, "rank");

    try {
      if (username) {
        const player = await resolvePlayer(username);

        if (!player || !player.uuid) {
          return res.send({
            success: false,
            message: "Player not found.",
          });
        }

        const mapped = await getRanksForUuid(player.uuid);

        return res.send({
          success: true,
          data: mapped,
          user: player,
        });
      }

      if (rankSlug) {
        const memberRows = await queryLuckPermsDb(
          `SELECT uuid FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
            WHERE permission = ? AND value = 1
              AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
          [`group.${rankSlug}`]
        );
        const uuids = memberRows.map((r) => r.uuid);
        if (!uuids.length) {
          return res.send({ success: true, data: [] });
        }

        const placeholders = uuids.map(() => "?").join(", ");

        const titleRows = await queryLuckPermsDb(
          `SELECT uuid, permission FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
            WHERE uuid IN (${placeholders}) AND permission LIKE ? AND value = 1`,
          [...uuids, `meta.group.${rankSlug}.title.%`]
        );
        const titleByUuid = {};
        for (const row of titleRows) {
          const match = row.permission.match(/\.title\.(.+)$/);
          if (match) titleByUuid[row.uuid] = match[1];
        }

        // Resolve usernames — main DB first, then LuckPerms players table
        // for uuids without a linked web account.
        const webUsers = await queryDb(
          `SELECT userId, uuid, username FROM users WHERE uuid IN (${placeholders})`,
          uuids
        );
        const webByUuid = {};
        for (const u of webUsers) webByUuid[u.uuid.toLowerCase()] = u;

        const missingUuids = uuids.filter((uuid) => !webByUuid[uuid]);
        const lpNames = {};
        if (missingUuids.length) {
          const missingPlaceholders = missingUuids.map(() => "?").join(", ");
          const lpRows = await queryLuckPermsDb(
            `SELECT LOWER(uuid) AS uuid, username FROM ${LUCKPERMS_PLAYERS_TABLE} WHERE LOWER(uuid) IN (${missingPlaceholders})`,
            missingUuids
          );
          for (const { uuid, username } of lpRows) lpNames[uuid] = username;
        }

        const metaMap = await getRankMetaMap();
        const rankMetaRow = rankRowFromMeta(rankSlug, metaMap);

        const rows = uuids
          .map((uuid) => {
            const webUser = webByUuid[uuid];
            return {
              userId: webUser?.userId || null,
              uuid,
              username: webUser?.username || lpNames[uuid] || null,
              displayName: rankMetaRow.displayName,
              rankBadgeColour: rankMetaRow.rankBadgeColour,
              rankTextColour: rankMetaRow.rankTextColour,
              title: titleByUuid[uuid] || null,
            };
          })
          .sort((a, b) => (a.username || "").localeCompare(b.username || ""));

        return res.send({ success: true, data: rows });
      }

      const directory = await getRankDirectory();
      return res.send({ success: true, data: directory });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: `${error}` });
      }
    }
  });

  app.get(`${baseEndpoint}/user`, async function (req, res) {
    if (!isFeatureEnabled(features.ranks, res, lang)) return;
    const username = optional(req.query, "username");

    if (!username) {
      return res.send({
        success: false,
        message: "Username is required.",
      });
    }

    try {
      const player = await resolvePlayer(username);

      if (!player || !player.uuid) {
        return res.send({
          success: false,
          message: "Player not found.",
        });
      }

      const mappedRanks = await getRanksForUuid(player.uuid);

      return res.send({
        success: true,
        data: {
          user: player,
          ranks: mappedRanks,
        },
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: `${error}` });
      }
    }
  });

  app.post(`${baseEndpoint}/config/:rankSlug`, async function (req, res) {
    if (!isFeatureEnabled(features.ranks, res, lang)) return;

    const rankSlug = req.params.rankSlug;
    const {
      displayName,
      rankBadgeColour,
      rankTextColour,
      priority,
      discordRoleId,
      isStaff,
      isDonator,
    } = req.body || {};

    if (!rankSlug) {
      return res.send({ success: false, message: "Rank slug is required." });
    }

    try {
      const sanitizedBadge = normalizeColour(rankBadgeColour);
      const sanitizedText = normalizeColour(rankTextColour);
      let sanitizedPriority = null;

      if (priority !== undefined && priority !== null && priority !== "") {
        const parsed = Number(priority);
        if (Number.isNaN(parsed)) {
          return res.send({
            success: false,
            message: "Priority must be a number.",
          });
        }
        sanitizedPriority = Math.floor(parsed);
      }

      const sanitizedDiscord =
        discordRoleId !== undefined && discordRoleId !== null
          ? String(discordRoleId).trim()
          : null;

      const staffFlag =
        isStaff === undefined || isStaff === null
          ? null
          : parseBoolean(isStaff)
          ? "1"
          : "0";
      const donatorFlag =
        isDonator === undefined || isDonator === null
          ? null
          : parseBoolean(isDonator)
          ? "1"
          : "0";

      await updateGroupNode(rankSlug, "displayname", displayName || null);
      await updateGroupNode(rankSlug, "weight", sanitizedPriority);
      await updateGroupNode(rankSlug, "meta.discordid", sanitizedDiscord);
      await updateGroupNode(rankSlug, "meta.staff", staffFlag);
      await updateGroupNode(rankSlug, "meta.donator", donatorFlag);
      await updateGroupNode(rankSlug, "meta.rankbadgecolour", sanitizedBadge);
      await updateGroupNode(rankSlug, "meta.ranktextcolour", sanitizedText);
      await syncAllRanks();

      const [updatedRank] = await queryLuckPermsDb(
        `SELECT
            lpGroups.name AS rankSlug,
            COALESCE(SUBSTRING_INDEX(lpGroupDisplayName.permission, '.', -1), lpGroups.name) AS displayName,
            SUBSTRING_INDEX(lpGroupWeight.permission, '.', -1) AS priority,
            COALESCE(
              CONCAT('#', SUBSTRING_INDEX(lpMetaBadgeColour.permission, '.', -1)),
              CASE LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
                WHEN '0' THEN '#000000' WHEN '1' THEN '#0000AA' WHEN '2' THEN '#00AA00'
                WHEN '3' THEN '#00AAAA' WHEN '4' THEN '#AA0000' WHEN '5' THEN '#AA00AA'
                WHEN '6' THEN '#FFAA00' WHEN '7' THEN '#AAAAAA' WHEN '8' THEN '#555555'
                WHEN '9' THEN '#5555FF' WHEN 'a' THEN '#55FF55' WHEN 'b' THEN '#55FFFF'
                WHEN 'c' THEN '#FF5555' WHEN 'd' THEN '#FF55FF' WHEN 'e' THEN '#FFFF55'
                WHEN 'g' THEN '#DDD605' ELSE '#FFFFFF'
              END
            ) AS rankBadgeColour,
            COALESCE(
              CONCAT('#', SUBSTRING_INDEX(lpMetaTextColour.permission, '.', -1)),
              CASE WHEN LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
                IN ('0','1','2','3','4','5','8','9') THEN '#FFFFFF' ELSE '#000000' END
            ) AS rankTextColour,
            COALESCE(RIGHT(lpGroupStaff.permission, 1), '0')   AS isStaff,
            COALESCE(RIGHT(lpGroupDonator.permission, 1), '0') AS isDonator,
            SUBSTRING_INDEX(lpMetaDiscordId.permission, '.', -1) AS discordRoleId
          FROM luckperms_groups lpGroups
            -- Scoped to server='global'/world='global' to match what
            -- updateGroupNode() (just above) writes — a contextual override
            -- (e.g. server=events) would otherwise read back the wrong value.
            LEFT JOIN luckperms_group_permissions lpGroupDisplayName
              ON lpGroups.name = lpGroupDisplayName.name
              AND lpGroupDisplayName.permission LIKE 'displayname.%' AND lpGroupDisplayName.value = 1
              AND lpGroupDisplayName.server = 'global' AND lpGroupDisplayName.world = 'global'
            LEFT JOIN luckperms_group_permissions lpGroupWeight
              ON lpGroups.name = lpGroupWeight.name
              AND lpGroupWeight.permission LIKE 'weight.%' AND lpGroupWeight.value = 1
              AND lpGroupWeight.server = 'global' AND lpGroupWeight.world = 'global'
            LEFT JOIN luckperms_group_permissions lpGroupPrefix
              ON lpGroups.name = lpGroupPrefix.name
              AND lpGroupPrefix.permission LIKE 'prefix.%' AND lpGroupPrefix.value = 1
              AND lpGroupPrefix.server = 'global' AND lpGroupPrefix.world = 'global'
            LEFT JOIN luckperms_group_permissions lpGroupStaff
              ON lpGroups.name = lpGroupStaff.name
              AND lpGroupStaff.permission LIKE 'meta.staff.%' AND lpGroupStaff.value = 1
              AND lpGroupStaff.server = 'global' AND lpGroupStaff.world = 'global'
            LEFT JOIN luckperms_group_permissions lpGroupDonator
              ON lpGroups.name = lpGroupDonator.name
              AND lpGroupDonator.permission LIKE 'meta.donator.%' AND lpGroupDonator.value = 1
              AND lpGroupDonator.server = 'global' AND lpGroupDonator.world = 'global'
            LEFT JOIN luckperms_group_permissions lpMetaBadgeColour
              ON lpGroups.name = lpMetaBadgeColour.name
              AND lpMetaBadgeColour.permission LIKE 'meta.rankbadgecolour.%' AND lpMetaBadgeColour.value = 1
              AND lpMetaBadgeColour.server = 'global' AND lpMetaBadgeColour.world = 'global'
            LEFT JOIN luckperms_group_permissions lpMetaTextColour
              ON lpGroups.name = lpMetaTextColour.name
              AND lpMetaTextColour.permission LIKE 'meta.ranktextcolour.%' AND lpMetaTextColour.value = 1
              AND lpMetaTextColour.server = 'global' AND lpMetaTextColour.world = 'global'
            LEFT JOIN luckperms_group_permissions lpMetaDiscordId
              ON lpGroups.name = lpMetaDiscordId.name
              AND lpMetaDiscordId.permission LIKE 'meta.discordid.%' AND lpMetaDiscordId.value = 1
              AND lpMetaDiscordId.server = 'global' AND lpMetaDiscordId.world = 'global'
          WHERE lpGroups.name = ?
          LIMIT 1`,
        [rankSlug]
      );

      if (!updatedRank) {
        return res.send({
          success: false,
          message: "Unable to load the updated rank from LuckPerms.",
        });
      }

      return res.send({
        success: true,
        message: "Rank configuration updated.",
        data: mapRankRow(updatedRank),
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: `${error}` });
      }
    }
  });

  app.post(`${baseEndpoint}/user/assign`, async function (req, res) {
    if (!isFeatureEnabled(features.ranks, res, lang)) return;

    const { username, rankSlug, title, expiresAt } = req.body || {};

    if (!username || !rankSlug) {
      return res.send({
        success: false,
        message: "Username and rankSlug are required.",
      });
    }

    let expirySeconds = 0;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.send({ success: false, message: "Invalid expiry date." });
      }
      if (parsed.getTime() <= Date.now()) {
        return res.send({ success: false, message: "Expiry must be in the future." });
      }
      expirySeconds = Math.floor(parsed.getTime() / 1000);
    }

    try {
      const player = await resolvePlayer(username);

      if (!player || !player.uuid) {
        return res.send({ success: false, message: "Player not found." });
      }

      await normalizeUserPermissionContexts(player.uuid, rankSlug);

      const [existing] = await queryLuckPermsDb(
        `SELECT uuid FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ? AND permission = ? AND value = 1
            AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())
          LIMIT 1`,
        [player.uuid, `group.${rankSlug}`]
      );

      if (existing) {
        return res.send({
          success: false,
          message: "Player already has this rank.",
        });
      }

      await queryLuckPermsDb(
        `INSERT INTO ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          (uuid, permission, value, server, world, expiry, contexts)
        VALUES (?, ?, 1, 'global', 'global', ?, '{}')`,
        [player.uuid, `group.${rankSlug}`, expirySeconds]
      );

      await queryLuckPermsDb(
        `DELETE FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ?
            AND permission LIKE CONCAT('meta.group.', ?, '.title.%')`,
        [player.uuid, rankSlug]
      );

      if (title) {
        await queryLuckPermsDb(
          `INSERT INTO ${LUCKPERMS_USER_PERMISSIONS_TABLE}
            (uuid, permission, value, server, world, expiry, contexts)
          VALUES (?, ?, 1, 'global', 'global', 0, '{}')`,
          [player.uuid, `meta.group.${rankSlug}.title.${title.substring(0, 64)}`]
        );
      }

      await syncUserRanks(player.uuid);

      if (player.userId) {
        await syncMemberRankRoles(player.userId);
      }

      return res.send({
        success: true,
        message: "Rank assigned successfully.",
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: `${error}` });
      }
    }
  });

  app.post(`${baseEndpoint}/user/remove`, async function (req, res) {
    if (!isFeatureEnabled(features.ranks, res, lang)) return;

    const { username, rankSlug } = req.body || {};

    if (!username || !rankSlug) {
      return res.send({
        success: false,
        message: "Username and rankSlug are required.",
      });
    }

    if (rankSlug === "default") {
      return res.send({
        success: false,
        message: "The default rank cannot be removed.",
      });
    }

    try {
      const player = await resolvePlayer(username);

      if (!player || !player.uuid) {
        return res.send({ success: false, message: "Player not found." });
      }

      await normalizeUserPermissionContexts(player.uuid, rankSlug);

      const result = await queryLuckPermsDb(
        `DELETE FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ? AND permission = ?`,
        [player.uuid, `group.${rankSlug}`]
      );

      await queryLuckPermsDb(
        `DELETE FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ?
            AND permission LIKE CONCAT('meta.group.', ?, '.title.%')`,
        [player.uuid, rankSlug]
      );

      await syncUserRanks(player.uuid);

      if (player.userId && result?.affectedRows > 0) {
        await syncMemberRankRoles(player.userId);
      }

      return res.send({
        success: true,
        message:
          result?.affectedRows > 0
            ? "Rank removed successfully."
            : "Rank was not assigned to the player.",
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: `${error}` });
      }
    }
  });

  app.post(
    `${baseEndpoint}/user/permission/check`,
    async function (req, res) {
      if (!isFeatureEnabled(features.ranks, res, lang)) return;

      const { username, permission } = req.body || {};

      if (!username || !permission) {
        return res.send({
          success: false,
          message: "Username and permission are required.",
        });
      }

      try {
        const player = await resolvePlayer(username);

        if (!player || !player.userId) {
          return res.send({
            success: false,
            message: "Player must have an active web account to check permissions.",
          });
        }

        const userData = await new UserGetter().byUserId(player.userId);

        if (!userData) {
          return res.send({
            success: false,
            message: "Unable to load player profile.",
          });
        }

        const permissions = await getUserPermissions(userData);
        const hasPermission = permissionMatch(permissions, permission);

        return res.send({
          success: true,
          data: {
            hasPermission,
            permission,
            username: player.username,
            ranks: permissions.userRanks || [],
          },
        });
      } catch (error) {
        console.error(error);
        if (!res.sent) {
          return res.status(500).send({ success: false, message: `${error}` });
        }
      }
    }
  );
}
