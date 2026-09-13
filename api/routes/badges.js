/**
 * api/routes/badges.js
 *
 * Badge system API routes.
 *
 * Public (token required — all API routes use token auth):
 *   GET  /api/badges/user/:username    — badges for a profile page
 *
 * Admin (token required):
 *   GET    /admin/badges                     — list all badges
 *   POST   /admin/badges                     — create badge
 *   PUT    /admin/badges/:id                 — update badge
 *   DELETE /admin/badges/:id                 — delete badge
 *   POST   /admin/badges/:id/duplicate       — duplicate badge
 *   GET    /admin/badges/user/:userId        — badges for a user (by userId)
 *   POST   /admin/badges/:id/assign/:userId  — assign badge to user
 *   DELETE /admin/badges/:id/assign/:userId  — remove badge from user
 */

import {
  getAllBadges,
  getBadgeById,
  createBadge,
  updateBadge,
  deleteBadge,
  duplicateBadge,
  getBadgesForUser,
  assignBadgeToUser,
  removeBadgeFromUser,
} from "../../controllers/badgeController.js";
import { UserGetter } from "../../controllers/userController.js";

export default function badgeApiRoute(app, config, db, features, lang) {

  // =========================================================================
  // GET /api/badges/user/:username — public-facing profile badges
  // =========================================================================
  app.get("/api/badges/user/:username", async function (req, res) {
    const { username } = req.params;
    if (!username) return res.send({ success: false, message: "Username required." });

    try {
      const getter = new UserGetter();
      const user = await getter.byUsername(username);
      if (!user) return res.send({ success: false, message: "User not found." });

      const badges = await getBadgesForUser(user.userId);
      return res.send({ success: true, data: badges });
    } catch (error) {
      console.error("[badges] GET /api/badges/user/:username:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // GET /admin/badges — list all badges
  // =========================================================================
  app.get("/admin/badges", async function (req, res) {
    try {
      const badges = await getAllBadges();
      return res.send({ success: true, data: badges });
    } catch (error) {
      console.error("[badges] GET /admin/badges:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // POST /admin/badges — create badge
  // =========================================================================
  app.post("/admin/badges", async function (req, res) {
    const { name, description, backgroundColor, textColor, luckpermsGroup } = req.body || {};

    try {
      const badge = await createBadge({ name, description, backgroundColor, textColor, luckpermsGroup });
      return res.send({ success: true, message: "Badge created.", data: badge });
    } catch (error) {
      console.error("[badges] POST /admin/badges:", error);
      if (!res.sent) return res.status(400).send({ success: false, message: `${error.message || error}` });
    }
  });

  // =========================================================================
  // PUT /admin/badges/:id — update badge
  // =========================================================================
  app.put("/admin/badges/:id", async function (req, res) {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.send({ success: false, message: "Invalid badge id." });

    const { name, description, backgroundColor, textColor, luckpermsGroup } = req.body || {};

    try {
      const existing = await getBadgeById(id);
      if (!existing) return res.send({ success: false, message: "Badge not found." });

      const badge = await updateBadge(id, { name, description, backgroundColor, textColor, luckpermsGroup });
      return res.send({ success: true, message: "Badge updated.", data: badge });
    } catch (error) {
      console.error("[badges] PUT /admin/badges/:id:", error);
      if (!res.sent) return res.status(400).send({ success: false, message: `${error.message || error}` });
    }
  });

  // =========================================================================
  // DELETE /admin/badges/:id — delete badge
  // =========================================================================
  app.delete("/admin/badges/:id", async function (req, res) {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.send({ success: false, message: "Invalid badge id." });

    try {
      const existing = await getBadgeById(id);
      if (!existing) return res.send({ success: false, message: "Badge not found." });

      await deleteBadge(id);
      return res.send({ success: true, message: "Badge deleted." });
    } catch (error) {
      console.error("[badges] DELETE /admin/badges/:id:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // POST /admin/badges/:id/duplicate — duplicate badge
  // =========================================================================
  app.post("/admin/badges/:id/duplicate", async function (req, res) {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.send({ success: false, message: "Invalid badge id." });

    try {
      const badge = await duplicateBadge(id);
      return res.send({ success: true, message: "Badge duplicated.", data: badge });
    } catch (error) {
      console.error("[badges] POST /admin/badges/:id/duplicate:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error.message || error}` });
    }
  });

  // =========================================================================
  // GET /admin/badges/user/:userId — all badges for a specific user (by userId)
  // =========================================================================
  app.get("/admin/badges/user/:userId", async function (req, res) {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    try {
      const badges = await getBadgesForUser(userId);
      return res.send({ success: true, data: badges });
    } catch (error) {
      console.error("[badges] GET /admin/badges/user/:userId:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // POST /admin/badges/:id/assign/:userId — assign badge to user
  // =========================================================================
  app.post("/admin/badges/:id/assign/:userId", async function (req, res) {
    const badgeId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    if (!badgeId || !userId) return res.send({ success: false, message: "Invalid badge or user id." });

    try {
      const existing = await getBadgeById(badgeId);
      if (!existing) return res.send({ success: false, message: "Badge not found." });

      await assignBadgeToUser(userId, badgeId);
      return res.send({ success: true, message: "Badge assigned." });
    } catch (error) {
      console.error("[badges] POST /admin/badges/:id/assign/:userId:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // DELETE /admin/badges/:id/assign/:userId — remove badge from user
  // =========================================================================
  app.delete("/admin/badges/:id/assign/:userId", async function (req, res) {
    const badgeId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    if (!badgeId || !userId) return res.send({ success: false, message: "Invalid badge or user id." });

    try {
      await removeBadgeFromUser(userId, badgeId);
      return res.send({ success: true, message: "Badge removed from user." });
    } catch (error) {
      console.error("[badges] DELETE /admin/badges/:id/assign/:userId:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });
}
