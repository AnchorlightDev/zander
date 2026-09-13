import { optional } from "../common.js";
import { punishmentsDb } from "../../controllers/databaseController.js";

export default function punishmentsApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/punishments";

  app.get(baseEndpoint + "/get", async function (req, res) {
    const rawPage = optional(req.query, "page");
    const rawLimit = optional(req.query, "limit");

    const page = Math.max(parseInt(rawPage, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 25, 1), 100);
    const offset = (page - 1) * limit;

    try {
      // Query litebans tables directly on the dedicated punishments DB instance.
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
           ORDER BY litebans.time DESC
           LIMIT ? OFFSET ?`,
          [limit, offset],
          (error, results) => {
            if (error) {
              return reject(error);
            }

            resolve(results || []);
          }
        );
      });

      // Resolve banned/banner/remover UUIDs to usernames from the main DB in one query.
      const actorUuids = [
        ...new Set(
          rawPunishments.flatMap((p) =>
            [p.bannedUuid, p.bannedByUuid, p.removedByUuid].filter(Boolean)
          )
        ),
      ];
      let usernameByUuid = {};
      if (actorUuids.length > 0) {
        const placeholders = actorUuids
          .map(() => "REPLACE(uuid, '-', '') = ?")
          .join(" OR ");
        const normalized = actorUuids.map((u) =>
          u.replace(/-/g, "").toLowerCase()
        );
        const usersRows = await new Promise((resolve, reject) => {
          db.query(
            `SELECT uuid, username FROM users WHERE ${placeholders}`,
            normalized,
            (error, results) => {
              if (error) {
                return reject(error);
              }

              resolve(results || []);
            }
          );
        });

        for (const row of usersRows) {
          usernameByUuid[row.uuid.replace(/-/g, "").toLowerCase()] =
            row.username;
        }
      }

      const lookupUsername = (uuid) =>
        uuid
          ? usernameByUuid[uuid.replace(/-/g, "").toLowerCase()] || null
          : null;

      const punishments = rawPunishments.map((p) => ({
        ...p,
        bannedUsername: lookupUsername(p.bannedUuid),
        bannedByUsername: lookupUsername(p.bannedByUuid),
        removedByUsername: lookupUsername(p.removedByUuid),
      }));

      return res.send({
        success: true,
        data: punishments,
        page: page,
        limit: limit,
      });
    } catch (error) {
      console.error("Failed to fetch punishments", error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });
}
