/**
 * routes/dashboard/holograms.js
 *
 * Admin dashboard for the in-game rotating hologram frames.
 *
 *   GET  /dashboard/holograms            — list frames grouped by hologram group
 *   GET  /dashboard/holograms/create     — new-frame editor
 *   GET  /dashboard/holograms/edit?id=   — edit-frame editor
 *   POST /dashboard/holograms/create     — create a frame
 *   POST /dashboard/holograms/edit       — update a frame
 *   POST /dashboard/holograms/delete     — delete a frame
 *   POST /dashboard/holograms/toggle     — enable / disable a frame
 *   POST /dashboard/holograms/move       — reorder a frame within its group
 *
 * Writes call the controller in-process (no self-HTTP round trip). The zander-hub
 * plugin reads the published frames via GET /api/hologram/messages.
 */
import {
  getGlobalImage,
  hasPermission,
  isFeatureWebRouteEnabled,
} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  getAllMessages,
  getGroups,
  getMessageById,
  createMessage,
  updateMessage,
  deleteMessage,
  setEnabled,
  moveMessage,
} from "../../controllers/hologramController.js";

const PERMISSION_NODE = "zander.web.holograms";

export default function dashboardHologramsRoute(app, config, db, features, lang) {
  // ── List ──────────────────────────────────────────────────────────────────
  app.get("/dashboard/holograms", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.holograms, req, res, features)) return;
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;

    const [messages, globalImage, announcementWeb] = await Promise.all([
      getAllMessages().catch((err) => {
        console.error("[dashboard/holograms] failed to load frames:", err);
        return null;
      }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/holograms/holograms-list", {
        pageTitle: "Holograms",
        config,
        req,
        features,
        apiData: { success: messages !== null, data: messages || [] },
        globalImage,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  // ── Create / edit editor pages ─────────────────────────────────────────────
  async function renderEditor(req, res, { type, frame }) {
    const [groups, globalImage, announcementWeb] = await Promise.all([
      getGroups().catch(() => []),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/holograms/holograms-editor", {
        pageTitle: type === "create" ? "Create Hologram Frame" : "Edit Hologram Frame",
        config,
        req,
        features,
        type,
        frame: frame || null,
        groups,
        globalImage,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  }

  app.get("/dashboard/holograms/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.holograms, req, res, features)) return;
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;
    return renderEditor(req, res, { type: "create" });
  });

  app.get("/dashboard/holograms/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.holograms, req, res, features)) return;
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;

    const id = Number.parseInt(req.query.id, 10);
    const frame = Number.isInteger(id) ? await getMessageById(id) : null;
    if (!frame) return res.redirect("/dashboard/holograms");
    return renderEditor(req, res, { type: "edit", frame });
  });

  // ── Writes ──────────────────────────────────────────────────────────────────
  function parseBody(body) {
    // countdown_to arrives as a UTC ISO string (the editor converts the local
    // datetime-local value before submit) or empty when there is no countdown.
    const countdownTo = typeof body?.countdown_to === "string" && body.countdown_to.trim()
      ? body.countdown_to.trim()
      : null;
    const finishedText = typeof body?.countdown_finished_text === "string" && body.countdown_finished_text.trim()
      ? body.countdown_finished_text.trim().slice(0, 512)
      : null;
    // expires_at arrives as a UTC ISO string (the editor converts the local
    // datetime-local value before submit) or empty when the frame never expires.
    const expiresAt = typeof body?.expires_at === "string" && body.expires_at.trim()
      ? body.expires_at.trim()
      : null;
    return {
      hologram_group: body?.hologram_group ?? "default",
      message: body?.message ?? "",
      link: body?.link?.trim() ? body.link.trim() : null,
      countdown_to: countdownTo,
      // A finished text only makes sense alongside a countdown target.
      countdown_finished_text: countdownTo ? finishedText : null,
      expires_at: expiresAt,
      sort_order: Number.parseInt(body?.sort_order, 10) || 0,
      enabled: String(body?.enabled) === "1" ? 1 : 0,
    };
  }

  app.post("/dashboard/holograms/create", async function (req, res) {
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;
    const data = parseBody(req.body);
    if (!String(data.message).trim()) {
      return res.redirect("/dashboard/holograms/create");
    }
    try {
      await createMessage(data);
    } catch (error) {
      console.error("[dashboard/holograms] create failed:", error);
    }
    return res.redirect("/dashboard/holograms");
  });

  app.post("/dashboard/holograms/edit", async function (req, res) {
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;
    const id = Number.parseInt(req.body?.id, 10);
    if (!Number.isInteger(id)) return res.redirect("/dashboard/holograms");
    try {
      await updateMessage(id, parseBody(req.body));
    } catch (error) {
      console.error("[dashboard/holograms] edit failed:", error);
    }
    return res.redirect("/dashboard/holograms");
  });

  app.post("/dashboard/holograms/delete", async function (req, res) {
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;
    const id = Number.parseInt(req.body?.id, 10);
    if (Number.isInteger(id)) {
      try {
        await deleteMessage(id);
      } catch (error) {
        console.error("[dashboard/holograms] delete failed:", error);
      }
    }
    return res.redirect("/dashboard/holograms");
  });

  app.post("/dashboard/holograms/toggle", async function (req, res) {
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;
    const id = Number.parseInt(req.body?.id, 10);
    if (Number.isInteger(id)) {
      try {
        await setEnabled(id, String(req.body?.enabled) === "1" ? 1 : 0);
      } catch (error) {
        console.error("[dashboard/holograms] toggle failed:", error);
      }
    }
    return res.redirect("/dashboard/holograms");
  });

  app.post("/dashboard/holograms/move", async function (req, res) {
    if (!await hasPermission(PERMISSION_NODE, req, res, features)) return;
    const id = Number.parseInt(req.body?.id, 10);
    const direction = req.body?.direction === "up" ? "up" : "down";
    if (Number.isInteger(id)) {
      try {
        await moveMessage(id, direction);
      } catch (error) {
        console.error("[dashboard/holograms] move failed:", error);
      }
    }
    return res.redirect("/dashboard/holograms");
  });
}
