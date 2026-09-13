/**
 * routes/dashboard/apiClients.js
 *
 * Admin dashboard for per-client API credentials.
 *
 *   GET  /dashboard/apikeys              — list clients, create form
 *   POST /dashboard/apikeys              — create a client, show its key once
 *   POST /dashboard/apikeys/:id/revoke   — soft-revoke a client
 *
 * The full key exists only in the response to the create POST.  It is never
 * stored in the session, never re-rendered, and never logged.
 */

import { getGlobalImage, hasPermission } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  API_SCOPES,
  createClient,
  listClients,
  revokeClient,
} from "../../controllers/apiClientController.js";

const PERMISSION_NODE = "zander.web.apikeys";

export default function dashboardApiClientsRoute(app, config, db, features, lang) {
  /** Shared view payload so the list renders identically on GET and after a POST. */
  async function renderList(req, res, extra = {}) {
    const [clients, globalImage, announcementWeb] = await Promise.all([
      listClients(),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/apiclients/index", {
        pageTitle: "Dashboard - API Keys",
        config,
        req,
        features,
        clients,
        apiScopes: API_SCOPES,
        newKey: null,
        error: null,
        globalImage,
        announcementWeb,
        ...extra,
      })
    );
  }

  // =========================================================================
  // GET /dashboard/apikeys
  // =========================================================================
  app.get("/dashboard/apikeys", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    try {
      return await renderList(req, res);
    } catch (error) {
      console.error("[dashboard/apikeys] failed to list clients:", error);
      return await renderList(req, res, {
        clients: [],
        error: "Could not load API clients.",
      }).catch(() => res.status(500).send({ success: false }));
    }
  });

  // =========================================================================
  // POST /dashboard/apikeys — create
  // =========================================================================
  app.post("/dashboard/apikeys", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const { name, description } = req.body ?? {};

    // A single checkbox posts a string, several post an array.
    const raw = req.body?.scopes;
    const scopes = Array.isArray(raw) ? raw : raw ? [raw] : [];

    try {
      const created = await createClient({
        name,
        description,
        scopes,
        createdByUserId: req.session?.user?.userId ?? null,
      });

      // Rendered once, here, and never again.
      return await renderList(req, res, { newKey: created });
    } catch (error) {
      console.error("[dashboard/apikeys] failed to create client:", error);
      return await renderList(req, res, {
        error: error?.message || "Could not create the API client.",
      });
    }
  });

  // =========================================================================
  // POST /dashboard/apikeys/:id/revoke — soft delete, row kept for audit
  // =========================================================================
  app.post("/dashboard/apikeys/:id/revoke", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const clientId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(clientId)) {
      return res.redirect("/dashboard/apikeys");
    }

    try {
      await revokeClient(clientId);
    } catch (error) {
      console.error("[dashboard/apikeys] failed to revoke client:", error);
    }

    return res.redirect("/dashboard/apikeys");
  });
}
