export default async function webApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/web";

  const { luckpermsDb } = await import("../../controllers/databaseController.js");

  app.get(baseEndpoint + "/configuration", async function (req, res) {
    // There is no isFeatureEnabled() due to being a critical endpoint.

    return res.send({
      success: true,
      data: {
        siteName: config.siteConfiguration.siteName,
        siteAddress: process.env.siteAddress,
      },
    });
  });

  app.get(baseEndpoint + "/statistics", async function (req, res) {
    // There is no isFeatureEnabled() due to being a critical endpoint.

    try {
      const [mainResults, staffResults] = await Promise.all([
        new Promise((resolve, reject) => {
          db.query(
            `
            SELECT COUNT(DISTINCT gs.userId) AS communityMembers
            FROM gameSessions gs
            JOIN users u ON gs.userId = u.userId
            WHERE gs.sessionStart >= DATE_SUB(NOW(), INTERVAL 3 MONTH)
              AND u.account_disabled = 0;

            SELECT ROUND(SUM(TIMESTAMPDIFF(SECOND, gs.sessionStart, COALESCE(gs.sessionEnd, NOW()))) / 3600) AS timePlayed
            FROM gameSessions gs
            JOIN users u ON gs.userId = u.userId
            WHERE gs.sessionStart >= DATE_SUB(NOW(), INTERVAL 3 MONTH)
              AND u.account_disabled = 0;
`,
            (err, results) => {
              if (err) return reject(err);
              resolve(results);
            }
          );
        }),
        new Promise((resolve, reject) => {
          luckpermsDb.query(
            // meta.staff.1 exactly: the rank editor writes meta.staff.0 on every
            // non-staff group it saves, so matching meta.staff.% counted every
            // member of every edited rank. Same staff definition as the staff
            // page (controllers/staffController.js): staff flag set, not a
            // donator rank, default/retired excluded. Expired temporary
            // memberships are left out too.
            `SELECT COUNT(DISTINCT lup.uuid) AS totalStaff
             FROM luckperms_user_permissions lup
             JOIN luckperms_group_permissions lgp
               ON lgp.name = SUBSTRING_INDEX(lup.permission, '.', -1)
               AND lgp.permission = 'meta.staff.1'
               AND lgp.value = 1
               AND lgp.server = 'global' AND lgp.world = 'global'
             WHERE lup.permission LIKE 'group.%'
               AND lup.value = 1
               AND (lup.expiry IS NULL OR lup.expiry = 0 OR lup.expiry > UNIX_TIMESTAMP())
               AND SUBSTRING_INDEX(lup.permission, '.', -1) NOT IN ('default', 'retired')
               AND NOT EXISTS (
                 SELECT 1 FROM luckperms_group_permissions don
                  WHERE don.name = lgp.name
                    AND don.permission = 'meta.donator.1'
                    AND don.value = 1
               )`,
            (err, results) => {
              if (err) return reject(err);
              resolve(results);
            }
          );
        }),
      ]);

      // General
      const communityMembers = mainResults[0][0].communityMembers || 0;
      const timePlayed = mainResults[1][0].timePlayed || 0;
      const staffMembers = staffResults[0].totalStaff || 0;

      return res.send({
        success: true,
        data: {
          general: {
            communityMembers: communityMembers,
            timePlayed: timePlayed,
            staffMembers: staffMembers,
          },
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).send({
        success: false,
        message: "Internal Server Error",
      });
    }
  });

  app.get(baseEndpoint + "/logs/get", async function (req, res) {
    try {
      const filters = [];
      const params = [];
      const userFilter = req.query?.user ? String(req.query.user).trim() : "";
      const featureFilter = req.query?.feature
        ? String(req.query.feature).trim()
        : "";

      if (userFilter) {
        filters.push("(u.username = ? OR l.creatorId = ?)");
        params.push(userFilter);
        params.push(Number.isNaN(Number(userFilter)) ? -1 : Number(userFilter));
      }

      if (featureFilter) {
        filters.push("l.logFeature = ?");
        params.push(featureFilter);
      }

      const whereClause = filters.length
        ? `WHERE ${filters.join(" AND ")}`
        : "";

      const results = await new Promise((resolve, reject) => {
        db.query(
          `SELECT l.logId, l.creatorId, u.username AS actionedUsername, l.logFeature, l.logType, l.description, l.actionedDateTime FROM logs l LEFT JOIN users u ON l.creatorId = u.userId ${whereClause} ORDER BY l.actionedDateTime DESC;`,
          params,
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      if (!results || !results.length) {
        return res.send({
          success: false,
          message: `There are no logs`,
        });
      }

      return res.send({
        success: true,
        data: results,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).send({
        success: false,
        message: `${error}`,
      });
    }
  });
}
