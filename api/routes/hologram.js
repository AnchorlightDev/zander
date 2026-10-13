import { isFeatureEnabled } from "../common.js";
import { getActiveMessages } from "../../controllers/hologramController.js";

/**
 * Hub-facing hologram API.
 *
 * GET /api/hologram/messages — every enabled frame, flat, ordered by group then
 * sort order. The zander-hub plugin polls this on an interval, groups the rows
 * by `hologram_group`, and cycles each placed hologram through its group's
 * frames. Token-authenticated (scope `hologram`, see lib/apiKeys.js); there is
 * no dashboard-session fallback because only the plugin reads it.
 *
 * Dashboard writes (create/edit/delete/reorder) are handled in-process by
 * routes/dashboard/holograms.js — they do not round-trip through the API.
 */
export default function hologramApiRoute(app, config, db, features, lang) {
  app.get("/api/hologram/messages", async function (req, res) {
    if (!isFeatureEnabled(features.holograms, res, lang)) return;

    try {
      const rows = await getActiveMessages();
      return res.send({
        success: true,
        data: rows.map((r) => ({
          group: r.hologram_group,
          message: r.message,
          link: r.link || null,
        })),
      });
    } catch (error) {
      console.error("[hologram] Failed to load messages:", error);
      if (!res.sent) {
        return res.status(500).send({ success: false, message: `${error}` });
      }
    }
  });
}
