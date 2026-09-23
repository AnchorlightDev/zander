/**
 * routes/dashboard/webstoreCategories.js
 *
 * Manage the categories the webstore catalog is grouped into.
 *
 * Categories used to be a free-text box on each product, so a typo silently
 * created a second category and `categorySortOrder` could disagree between two
 * rows claiming the same one. They are rows now, edited here.
 *
 * Hiding a category takes its whole section off the public page regardless of
 * what each product inside it is set to -- see lib/webstore/catalogVisibility.mjs.
 */

import { hasPermission, isFeatureWebRouteEnabled, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  getAllCategories,
  getAllCategoriesWithCounts,
  getCategory,
  createCategory,
  updateCategory,
  setCategoryVisibility,
  deleteCategory,
  reassignProducts,
  CategoryInUseError,
  DuplicateCategoryError,
} from "../../controllers/webstoreCategoryController.js";

const LIST_PATH = "/dashboard/webstore/categories";

/** Checkbox values arrive as "on"; a toggle may post "1"/"true". */
function checked(value) {
  return value === "on" || value === "1" || value === "true";
}

export default function dashboardWebstoreCategoriesRoute(app, config, db, features, lang) {

  async function guard(req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return false;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return false;
    return true;
  }

  // ── List ──────────────────────────────────────────────────────────────────
  app.get(LIST_PATH, async (req, res) => {
    if (!await guard(req, res)) return;

    const [categories, announcementWeb] = await Promise.all([
      getAllCategoriesWithCounts(),
      getWebAnnouncement(),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/rank-catalog/categories", {
        pageTitle: "Webstore Categories",
        config, features, req, announcementWeb,
        categories,
      })
    );
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.post(`${LIST_PATH}/create`, async (req, res) => {
    if (!await guard(req, res)) return;

    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) {
      setBannerCookie("danger", "A category needs a name.", res);
      return res.redirect(LIST_PATH);
    }

    try {
      await createCategory({
        name,
        sortOrder: body.sortOrder,
        visible: checked(body.visible),
      });
      setBannerCookie("success", `Category "${name}" created.`, res);
    } catch (err) {
      if (err instanceof DuplicateCategoryError) {
        setBannerCookie("warning", err.message, res);
      } else {
        console.error("[webstore-categories] create error:", err);
        setBannerCookie("danger", "Could not create that category.", res);
      }
    }
    return res.redirect(LIST_PATH);
  });

  // ── Edit ──────────────────────────────────────────────────────────────────
  app.post(`${LIST_PATH}/:id/edit`, async (req, res) => {
    if (!await guard(req, res)) return;

    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) {
      setBannerCookie("danger", "A category needs a name.", res);
      return res.redirect(LIST_PATH);
    }

    try {
      await updateCategory(req.params.id, {
        name,
        sortOrder: body.sortOrder,
        visible: checked(body.visible),
      });
      setBannerCookie("success", `Category "${name}" saved.`, res);
    } catch (err) {
      if (err instanceof DuplicateCategoryError) {
        setBannerCookie("warning", err.message, res);
      } else {
        console.error("[webstore-categories] edit error:", err);
        setBannerCookie("danger", "Could not save that category.", res);
      }
    }
    return res.redirect(LIST_PATH);
  });

  // ── Show / hide ───────────────────────────────────────────────────────────
  app.post(`${LIST_PATH}/:id/visibility`, async (req, res) => {
    if (!await guard(req, res)) return;

    try {
      const visible = checked((req.body || {}).visible);
      await setCategoryVisibility(req.params.id, visible);
      const category = await getCategory(req.params.id);
      setBannerCookie(
        "success",
        `"${category?.name ?? "Category"}" is now ${visible ? "visible on" : "hidden from"} the store.`,
        res
      );
    } catch (err) {
      console.error("[webstore-categories] visibility error:", err);
      setBannerCookie("danger", "Could not change that category's visibility.", res);
    }
    return res.redirect(LIST_PATH);
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  // Optionally moves the products somewhere else first; without that a category
  // still holding products is refused rather than orphaning them.
  app.post(`${LIST_PATH}/:id/delete`, async (req, res) => {
    if (!await guard(req, res)) return;

    const moveTo = (req.body || {}).moveTo;

    try {
      // Only the last banner cookie written survives the redirect, so the move
      // and the delete are reported in one message rather than two.
      let movedNote = "";

      if (moveTo) {
        if (String(moveTo) === String(req.params.id)) {
          setBannerCookie("danger", "Pick a different category to move the products into.", res);
          return res.redirect(LIST_PATH);
        }
        const target = await getCategory(moveTo);
        if (!target) {
          setBannerCookie("danger", "That destination category no longer exists.", res);
          return res.redirect(LIST_PATH);
        }
        const moved = await reassignProducts(req.params.id, moveTo);
        if (moved) {
          movedNote = ` ${moved} product${moved === 1 ? "" : "s"} moved to "${target.name}".`;
        }
      }

      await deleteCategory(req.params.id);
      setBannerCookie("success", `Category deleted.${movedNote}`, res);
    } catch (err) {
      if (err instanceof CategoryInUseError) {
        setBannerCookie("warning", err.message, res);
      } else {
        console.error("[webstore-categories] delete error:", err);
        setBannerCookie("danger", "Could not delete that category.", res);
      }
    }
    return res.redirect(LIST_PATH);
  });
}
