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
 * requires the `compass` scope and is strictly read-only — Compass never writes
 * to Zander and never grants groups (group-granting stays entirely in Zander).
 */

import { UserGetter } from "../../controllers/userController.js";
import { getEffectiveGroups, isStaff } from "../../lib/permissions/effectiveGroups.mjs";
import { staffGroups } from "../../lib/oidc/accounts.mjs";

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
          isStaff: isStaff(groups, staffGroups()),
        },
      });
    } catch (error) {
      console.error("[compass] identity lookup failed:", error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: "Lookup failed." });
      }
    }
  });
}
