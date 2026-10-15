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
 * Countdown frames: when `countdownTo` is non-null (an ISO 8601 UTC instant), the
 * plugin substitutes these placeholders in `message` and re-renders every second:
 *   {countdown}  -> "2d 5h 30m 10s"
 *   {days} {hours} {minutes} {seconds}  -> the individual parts ("2", "5", "30", "10")
 * Once the instant has passed, `countdownFinishedText` (when non-null) replaces the
 * countdown; otherwise the plugin shows zeroes ("0d 0h 0m 0s"). A null `countdownTo`
 * means the message is static.
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
          countdownTo: r.countdown_to ? new Date(r.countdown_to).toISOString() : null,
          countdownFinishedText: r.countdown_finished_text || null,
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
