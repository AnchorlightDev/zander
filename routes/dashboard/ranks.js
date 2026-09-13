import {
  hasPermission,
  isFeatureWebRouteEnabled,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { luckpermsDb } from "../../controllers/databaseController.js";
import { getProfilePicture } from "../../controllers/userController.js";

function getUsersForRanks(rankSlugs) {
  if (!rankSlugs || !rankSlugs.length) return Promise.resolve([]);
  const permissions = rankSlugs.map((s) => `group.${s}`);
  const placeholders = permissions.map(() => "?").join(", ");
  return new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT
        lp.username,
        lup.uuid,
        SUBSTRING_INDEX(lup.permission, '.', -1) AS rankSlug
      FROM luckperms_user_permissions lup
      LEFT JOIN luckperms_players lp ON lup.uuid = lp.uuid
      WHERE lup.permission IN (${placeholders})
        AND lup.value = 1
      ORDER BY lp.username ASC`,
      permissions,
      (err, results) => {
        if (err) return reject(err);
        resolve(results || []);
      }
    );
  });
}

/**
 * Query LuckPerms directly for all rank groups.
 * Mirrors the logic of fetchLuckPermsRanks() in staffController.js and
 * also pulls the discord role ID metadata stored by the rank config editor.
 */
function getAllRanksFromLuckPerms() {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT
        lpGroups.name AS rankSlug,
        COALESCE(SUBSTRING_INDEX(lpGroupDisplayName.permission, '.', -1), lpGroups.name) AS displayName,
        SUBSTRING_INDEX(lpGroupWeight.permission, '.', -1) AS priority,
        COALESCE(
          CONCAT('#', SUBSTRING_INDEX(lpMetaBadgeColour.permission, '.', -1)),
          CASE LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
            WHEN '0' THEN '#000000'
            WHEN '1' THEN '#0000AA'
            WHEN '2' THEN '#00AA00'
            WHEN '3' THEN '#00AAAA'
            WHEN '4' THEN '#AA0000'
            WHEN '5' THEN '#AA00AA'
            WHEN '6' THEN '#FFAA00'
            WHEN '7' THEN '#AAAAAA'
            WHEN '8' THEN '#555555'
            WHEN '9' THEN '#5555FF'
            WHEN 'a' THEN '#55FF55'
            WHEN 'b' THEN '#55FFFF'
            WHEN 'c' THEN '#FF5555'
            WHEN 'd' THEN '#FF55FF'
            WHEN 'e' THEN '#FFFF55'
            WHEN 'g' THEN '#DDD605'
            ELSE '#FFFFFF'
          END
        ) AS rankBadgeColour,
        COALESCE(
          CONCAT('#', SUBSTRING_INDEX(lpMetaTextColour.permission, '.', -1)),
          CASE WHEN
            LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
              IN ('0','1','2','3','4','5','8','9') THEN '#FFFFFF'
            ELSE '#000000'
          END
        ) AS rankTextColour,
        COALESCE(RIGHT(lpGroupStaff.permission, 1), '0')    AS isStaff,
        COALESCE(RIGHT(lpGroupDonator.permission, 1), '0')  AS isDonator,
        SUBSTRING_INDEX(lpMetaDiscordId.permission, '.', -1) AS discordRoleId
      FROM luckperms_groups lpGroups
        -- Scoped to server='global'/world='global' to match how the rank
        -- config editor writes these nodes (updateGroupNode() in
        -- api/routes/ranks.js) — a contextual override on top of the global
        -- node (e.g. server=events) would otherwise produce duplicate/
        -- ambiguous rows for the same rank.
        LEFT JOIN luckperms_group_permissions lpGroupDisplayName
          ON lpGroups.name = lpGroupDisplayName.name
          AND lpGroupDisplayName.permission LIKE 'displayname.%'
          AND lpGroupDisplayName.value = 1
          AND lpGroupDisplayName.server = 'global' AND lpGroupDisplayName.world = 'global'
        LEFT JOIN luckperms_group_permissions lpGroupWeight
          ON lpGroups.name = lpGroupWeight.name
          AND lpGroupWeight.permission LIKE 'weight.%'
          AND lpGroupWeight.value = 1
          AND lpGroupWeight.server = 'global' AND lpGroupWeight.world = 'global'
        LEFT JOIN luckperms_group_permissions lpGroupPrefix
          ON lpGroups.name = lpGroupPrefix.name
          AND lpGroupPrefix.permission LIKE 'prefix.%'
          AND lpGroupPrefix.value = 1
          AND lpGroupPrefix.server = 'global' AND lpGroupPrefix.world = 'global'
        LEFT JOIN luckperms_group_permissions lpGroupStaff
          ON lpGroups.name = lpGroupStaff.name
          AND lpGroupStaff.permission LIKE 'meta.staff.%'
          AND lpGroupStaff.value = 1
          AND lpGroupStaff.server = 'global' AND lpGroupStaff.world = 'global'
        LEFT JOIN luckperms_group_permissions lpGroupDonator
          ON lpGroups.name = lpGroupDonator.name
          AND lpGroupDonator.permission LIKE 'meta.donator.%'
          AND lpGroupDonator.value = 1
          AND lpGroupDonator.server = 'global' AND lpGroupDonator.world = 'global'
        LEFT JOIN luckperms_group_permissions lpMetaBadgeColour
          ON lpGroups.name = lpMetaBadgeColour.name
          AND lpMetaBadgeColour.permission LIKE 'meta.rankbadgecolour.%'
          AND lpMetaBadgeColour.value = 1
          AND lpMetaBadgeColour.server = 'global' AND lpMetaBadgeColour.world = 'global'
        LEFT JOIN luckperms_group_permissions lpMetaTextColour
          ON lpGroups.name = lpMetaTextColour.name
          AND lpMetaTextColour.permission LIKE 'meta.ranktextcolour.%'
          AND lpMetaTextColour.value = 1
          AND lpMetaTextColour.server = 'global' AND lpMetaTextColour.world = 'global'
        LEFT JOIN luckperms_group_permissions lpMetaDiscordId
          ON lpGroups.name = lpMetaDiscordId.name
          AND lpMetaDiscordId.permission LIKE 'meta.discordid.%'
          AND lpMetaDiscordId.value = 1
          AND lpMetaDiscordId.server = 'global' AND lpMetaDiscordId.world = 'global'
      ORDER BY CAST(COALESCE(SUBSTRING_INDEX(lpGroupWeight.permission, '.', -1), 0) AS UNSIGNED) DESC,
               lpGroups.name ASC`,
      (error, results) => {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
}

export default function dashboardRanksRoute(
  app,
  fetch,
  config,
  db,
  features,
  lang
) {
  app.get("/dashboard/ranks/export-csv", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.ranks, req, res, features)) return;
    if (!await hasPermission("zander.web.rank", req, res, features)) return;

    const raw = (req.query.ranks || "").trim();
    if (!raw) {
      return res.status(400).send("No ranks specified");
    }

    const rankSlugs = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!rankSlugs.length) {
      return res.status(400).send("No valid ranks specified");
    }

    try {
      const rows = await getUsersForRanks(rankSlugs);

      const headers = ["username", "uuid", "rank"];
      const csvRows = [
        headers.join(","),
        ...rows.map((r) => [
          JSON.stringify(r.username || ""),
          JSON.stringify(r.uuid || ""),
          JSON.stringify(r.rankSlug || ""),
        ].join(",")),
      ];

      const filename = `rank-export-${rankSlugs.join("-")}-${new Date().toISOString().slice(0, 10)}.csv`;
      res
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(csvRows.join("\n"));
    } catch (err) {
      console.error("[RANKS] CSV export error:", err);
      if (!res.sent) return res.status(500).send("Export failed");
    }
  });

  // User prefix search for the username autocomplete on the rank tools form
  app.get("/dashboard/ranks/user-search", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.ranks, req, res, features)) return;
    if (!await hasPermission("zander.web.rank", req, res, features)) return;

    const q = (req.query.q || "").trim();
    if (!q || q.length < 2) return res.send({ results: [] });

    try {
      const rows = await new Promise((resolve, reject) => {
        db.query(
          `SELECT userId, username FROM users WHERE username LIKE ? ORDER BY username ASC LIMIT 8`,
          [`${q}%`],
          (err, results) => { if (err) return reject(err); resolve(results || []); }
        );
      });

      const results = await Promise.all(
        rows.map(async (row) => ({
          userId: row.userId,
          username: row.username,
          avatarUrl: await getProfilePicture(row.username),
        }))
      );

      return res.send({ results });
    } catch (error) {
      console.error("[dashboard/ranks] user-search error:", error);
      if (!res.sent) return res.status(500).send({ results: [] });
    }
  });

  app.get("/dashboard/ranks", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.ranks, req, res, features)) return;

    const hasRankPermission = await hasPermission(
      "zander.web.rank",
      req,
      res,
      features
    );

    if (!hasRankPermission) return;

    let ranks = [];
    try {
      const rows = await getAllRanksFromLuckPerms();
      ranks = rows.filter(
        (r) => !String(r.rankSlug ?? "").startsWith("griefdefender_")
      );
    } catch (err) {
      console.error("[RANKS] Failed to query LuckPerms:", err);
    }

    const announcementWeb = await getWebAnnouncement();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/ranks/index", {
        pageTitle: "Dashboard - Ranks",
        config,
        features,
        req,
        ranks,
        announcementWeb,
      })
    );
    return;
  });
}
