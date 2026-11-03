/**
 * api/routes/compass.js
 *
 * Read-only endpoints for the Compass staff portal's own Discord bot. Compass
 * runs its own Discord application (see Compass PLAN.md §6), so on every slash
 * command it must resolve a Discord user to a CFC account and their CURRENT
 * effective groups server-side. That lookup lives here rather than in Compass
 * because only Zander can see LuckPerms.
 *
 * Auth: the per-client API-key hook (api/routes/verifyToken.js). This surface
 * requires the `compass` scope. Everything is read-only EXCEPT the staff rank
 * list (PUT /api/compass/staff-groups): Compass's "Who can sign in" setting is
 * the source of truth for who may obtain a Compass token, so Compass pushes it
 * here. Compass still never grants groups (that stays entirely in Zander).
 */

import { UserGetter } from "../../controllers/userController.js";
import db, { luckpermsDb } from "../../controllers/databaseController.js";
import { getEffectiveGroups, isStaff } from "../../lib/permissions/effectiveGroups.mjs";
import { staffGroups } from "../../lib/oidc/accounts.mjs";
import { cleanStaffGroups, describeStaffGroups, setManagedStaffGroups } from "../../lib/oidc/staffGroups.mjs";
import { resolveAvatarUrl } from "../../lib/avatarHelpers.js";

export default function compassApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/compass";

  // GET /api/compass/identity/:discordId
  // → { sub, username, discordId, groups, isStaff } for the linked CFC account,
  //   or 404 if no account is linked to that Discord ID.
  app.get(baseEndpoint + "/identity/:discordId", async function (req, res) {
    const discordId = String(req.params.discordId || "").trim();
    if (!/^\d{5,32}$/.test(discordId)) {
      return res.status(400).send({ success: false, message: "Invalid Discord ID." });
    }

    try {
      const user = await new UserGetter().byDiscordId(discordId);
      if (!user) {
        return res.status(404).send({ success: false, message: "No linked CFC account." });
      }

      const groups = await getEffectiveGroups({
        uuid: user.uuid,
        userId: user.userId,
        username: user.username,
      });

      return res.send({
        success: true,
        data: {
          sub: String(user.userId),
          username: user.username,
          discordId: user.discordId,
          groups,
          isStaff: isStaff(groups, await staffGroups()),
        },
      });
    } catch (error) {
      console.error("[compass] identity lookup failed:", error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: "Lookup failed." });
      }
    }
  });

  // GET /api/compass/staff-groups
  // → { groups, source: "compass"|"zander", updatedBy, updatedAt } — the ranks
  //   currently allowed to obtain a Compass token, and where the list came from.
  app.get(baseEndpoint + "/staff-groups", async function (req, res) {
    try {
      return res.send({ success: true, data: await describeStaffGroups() });
    } catch (error) {
      console.error("[compass] staff-groups read failed:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Lookup failed." });
    }
  });

  // PUT /api/compass/staff-groups  { groups: string[] | null, updatedBy?: string }
  // Compass pushes its "Who can sign in" list here on save and on boot. An empty
  // list or null clears it, so Zander's own default (config.compass.staffGroups)
  // applies again — matching Compass's "nothing ticked → leave it to Zander".
  app.put(baseEndpoint + "/staff-groups", async function (req, res) {
    const raw = req.body?.groups;
    const groups = raw === null || raw === undefined ? [] : cleanStaffGroups(raw);
    if (groups === null) {
      return res.status(400).send({ success: false, message: "groups must be an array of rank slugs." });
    }
    try {
      const data = await setManagedStaffGroups(groups, { updatedBy: req.body?.updatedBy });
      console.log(
        `[compass] staff rank list ${groups.length ? `set to [${groups.join(", ")}]` : "cleared"}` +
          (req.body?.updatedBy ? ` by ${String(req.body.updatedBy).slice(0, 80)}` : "")
      );
      return res.send({ success: true, data });
    } catch (error) {
      console.error("[compass] staff-groups save failed:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Save failed." });
    }
  });

  // GET /api/compass/groups
  // → { groups: [{ name, displayName, weight }, ...] } — every LuckPerms group
  //   with its display name (the `displayname.<value>` node) and weight, so
  //   Compass can offer a rank picker using friendly names. Read-only.
  app.get(baseEndpoint + "/groups", async function (req, res) {
    try {
      const rows = await new Promise((resolve, reject) => {
        luckpermsDb.query(
          `SELECT g.name AS name,
                  (SELECT SUBSTRING(gp.permission, 13)
                     FROM luckperms_group_permissions gp
                    WHERE gp.name = g.name AND gp.permission LIKE 'displayname.%'
                    LIMIT 1) AS displayName,
                  (SELECT SUBSTRING(gp.permission, 8)
                     FROM luckperms_group_permissions gp
                    WHERE gp.name = g.name AND gp.permission LIKE 'weight.%'
                    LIMIT 1) AS weight
             FROM luckperms_groups g
            ORDER BY g.name ASC`,
          [],
          (err, results) => {
            if (err) return reject(err);
            resolve(results || []);
          }
        );
      });
      const groups = rows
        .filter((r) => r.name)
        .map((r) => ({
          name: r.name,
          displayName: r.displayName || null,
          weight: r.weight ? Number(r.weight) || null : null,
        }));
      return res.send({ success: true, data: { groups } });
    } catch (error) {
      console.error("[compass] groups list failed:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Lookup failed." });
    }
  });

  // GET /api/compass/members?groups=mod,admin
  // → { members: [{ sub, username, uuid, avatarUrl }] } — CFC users who directly
  //   hold any of the given LuckPerms groups (global, non-expiring). avatarUrl is
  //   each user's resolved profile picture (Gravatar or Minecraft head), so
  //   Compass's assignee/member avatars match the rest of the CFC site. For
  //   assignee pickers.
  app.get(baseEndpoint + "/members", async function (req, res) {
    const groups = String(req.query?.groups || "")
      .split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);
    if (!groups.length) return res.send({ success: true, data: { members: [] } });

    try {
      const nodes = groups.map((g) => `group.${g}`);
      const placeholders = nodes.map(() => "?").join(", ");
      const uuidRows = await new Promise((resolve, reject) => {
        luckpermsDb.query(
          `SELECT DISTINCT uuid FROM luckperms_user_permissions
            WHERE permission IN (${placeholders})
              AND value = 1 AND server = 'global' AND world = 'global'
              AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
          nodes,
          (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
      });
      const uuids = uuidRows.map((r) => r.uuid).filter(Boolean);
      if (!uuids.length) return res.send({ success: true, data: { members: [] } });

      const ph = uuids.map(() => "?").join(", ");
      const users = await new Promise((resolve, reject) => {
        db.query(
          `SELECT userId, uuid, username, profilePicture_type, profilePicture_email
             FROM users WHERE uuid IN (${ph}) AND account_disabled = 0`,
          uuids,
          (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
      });
      const members = await Promise.all(
        users.map(async (u) => ({
          sub: String(u.userId),
          username: u.username,
          uuid: u.uuid,
          avatarUrl: await resolveAvatarUrl(u).catch(() => null),
        }))
      );
      return res.send({ success: true, data: { members } });
    } catch (error) {
      console.error("[compass] members list failed:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Lookup failed." });
    }
  });
}
