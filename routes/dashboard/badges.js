/**
 * routes/dashboard/badges.js
 *
 * Admin dashboard routes for the Badge system.
 *
 *   GET  /dashboard/badges                    — badge list & management
 *   GET  /dashboard/badges/create             — create badge form
 *   GET  /dashboard/badges/:id/edit           — edit badge form
 *   GET  /dashboard/badges/:id/assign         — assign badge to a user form
 *
 * Session-authenticated proxy routes (forward to /admin/badges API):
 *   POST   /dashboard/badges
 *   PUT    /dashboard/badges/:id
 *   DELETE /dashboard/badges/:id
 *   POST   /dashboard/badges/:id/duplicate
 *   POST   /dashboard/badges/:id/assign/:userId
 *   DELETE /dashboard/badges/:id/assign/:userId
 */

import {
  getGlobalImage,
  hasPermission,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import db from "../../controllers/databaseController.js";
import { getProfilePicture } from "../../controllers/userController.js";
import {
  assignBadgeToUser,
  removeBadgeFromUser,
  getBadgeById,
} from "../../controllers/badgeController.js";

async function proxyToApi(fetch, method, path, body) {
  const res = await fetch(`${process.env.siteAddress}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-access-token": process.env.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export default function dashboardBadgesRoute(app, fetch, config, db, features, lang) {

  // =========================================================================
  // GET /dashboard/badges — badge list & management
  // =========================================================================
  app.get("/dashboard/badges", async function (req, res) {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;

    let badgesData = { success: false, data: [] };
    try {
      const r = await fetch(`${process.env.siteAddress}/admin/badges`, {
        headers: { "x-access-token": process.env.apiKey },
      });
      badgesData = await r.json();
    } catch (error) {
      console.error("[dashboard/badges] Failed to fetch badges:", error);
    }

    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/badges/index", {
        pageTitle: "Dashboard - Badges",
        config,
        req,
        features,
        badgesData,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  // =========================================================================
  // GET /dashboard/badges/create — create badge form
  // =========================================================================
  app.get("/dashboard/badges/create", async function (req, res) {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;

    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/badges/edit", {
        pageTitle: "Dashboard - Create Badge",
        config,
        req,
        features,
        badge: null,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  // User autocomplete for the assign form (session-authenticated, prefix search)
  // Registered before parameterized routes so Fastify's static-segment preference is explicit.
  app.get("/dashboard/badges/user-search", async (req, res) => {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;

    const q = (req.query.q || "").trim();
    if (!q || q.length < 2) return res.send({ results: [] });

    try {
      const rows = await new Promise((resolve, reject) => {
        db.query(
          `SELECT userId, username, uuid, profilePicture_type, profilePicture_email
             FROM users WHERE username LIKE ? ORDER BY username ASC LIMIT 8`,
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
      console.error("[dashboard/badges] user-search error:", error);
      if (!res.sent) return res.status(500).send({ results: [] });
    }
  });

  // =========================================================================
  // GET /dashboard/badges/:id/edit — edit badge form
  // =========================================================================
  app.get("/dashboard/badges/:id/edit", async function (req, res) {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;

    const id = parseInt(req.params.id, 10);
    if (!id) return res.redirect("/dashboard/badges");

    let badge = null;
    try {
      const r = await fetch(`${process.env.siteAddress}/admin/badges`, {
        headers: { "x-access-token": process.env.apiKey },
      });
      const all = await r.json();
      badge = (all.data || []).find((b) => b.badgeId === id) || null;
    } catch (error) {
      console.error("[dashboard/badges] Failed to fetch badge for edit:", error);
    }

    if (!badge) return res.redirect("/dashboard/badges");

    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/badges/edit", {
        pageTitle: "Dashboard - Edit Badge",
        config,
        req,
        features,
        badge,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  // =========================================================================
  // GET /dashboard/badges/:id/assign — assign badge to user form
  // =========================================================================
  app.get("/dashboard/badges/:id/assign", async function (req, res) {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;

    const id = parseInt(req.params.id, 10);
    if (!id) return res.redirect("/dashboard/badges");

    let badge = null;
    try {
      const r = await fetch(`${process.env.siteAddress}/admin/badges`, {
        headers: { "x-access-token": process.env.apiKey },
      });
      const all = await r.json();
      badge = (all.data || []).find((b) => b.badgeId === id) || null;
    } catch (error) {
      console.error("[dashboard/badges] Failed to fetch badge for assign:", error);
    }

    if (!badge) return res.redirect("/dashboard/badges");

    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/badges/assign", {
        pageTitle: "Dashboard - Assign Badge",
        config,
        req,
        features,
        badge,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  // =========================================================================
  // Session-authenticated proxy routes
  // =========================================================================

  app.post("/dashboard/badges", async (req, res) => {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;
    res.send(await proxyToApi(fetch, "POST", "/admin/badges", req.body));
    return;
  });

  app.put("/dashboard/badges/:id", async (req, res) => {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;
    res.send(await proxyToApi(fetch, "PUT", `/admin/badges/${req.params.id}`, req.body));
    return;
  });

  app.delete("/dashboard/badges/:id", async (req, res) => {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;
    res.send(await proxyToApi(fetch, "DELETE", `/admin/badges/${req.params.id}`));
    return;
  });

  app.post("/dashboard/badges/:id/duplicate", async (req, res) => {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;
    res.send(await proxyToApi(fetch, "POST", `/admin/badges/${req.params.id}/duplicate`));
    return;
  });

  app.post("/dashboard/badges/:id/assign/:userId", async (req, res) => {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;
    const badgeId = parseInt(req.params.id, 10);
    const userId  = parseInt(req.params.userId, 10);
    if (!badgeId || !userId) return res.send({ success: false, message: "Invalid badge or user id." });
    try {
      const badge = await getBadgeById(badgeId);
      if (!badge) return res.send({ success: false, message: "Badge not found." });
      await assignBadgeToUser(userId, badgeId);
      return res.send({ success: true, message: "Badge assigned." });
    } catch (err) {
      console.error("[dashboard/badges] assign error:", err);
      return res.send({ success: false, message: err.message || "Failed to assign badge." });
    }
  });

  app.delete("/dashboard/badges/:id/assign/:userId", async (req, res) => {
    if (!await hasPermission("zander.web.badges", req, res, features)) return;
    const badgeId = parseInt(req.params.id, 10);
    const userId  = parseInt(req.params.userId, 10);
    if (!badgeId || !userId) return res.send({ success: false, message: "Invalid badge or user id." });
    try {
      await removeBadgeFromUser(userId, badgeId);
      return res.send({ success: true, message: "Badge removed from user." });
    } catch (err) {
      console.error("[dashboard/badges] remove error:", err);
      return res.send({ success: false, message: err.message || "Failed to remove badge." });
    }
  });

}
