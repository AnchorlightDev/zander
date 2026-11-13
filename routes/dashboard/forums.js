import {
  getGlobalImage,
  hasPermission,
  setBannerCookie,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  getAllCategoriesForAdmin,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategoryById,
} from "../../controllers/forumController.js";
import { getBridgeByCategoryId, getOutboxStats, listBridges } from "../../controllers/forumBridgeController.js";

const MANAGE_PERMISSION = "zander.forums.category.manage";

export default function dashboardForumsRoutes(
  app,
  fetch,
  config,
  db,
  features,
  lang
) {
  app.get("/dashboard/forums/categories", async function (req, res) {
    const hasAccess = await hasPermission(
      MANAGE_PERMISSION,
      req,
      res,
      features
    );
    if (!hasAccess) return;

    const editId = Number.parseInt(req.query.edit, 10) || null;
    const createUnderId = Number.parseInt(req.query.create_under, 10) || null;

    const [categoryTree, categoryToEdit, globalImage, announcementWeb] = await Promise.all([
      getAllCategoriesForAdmin(),
      editId ? getCategoryById(editId) : Promise.resolve(null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    // Discord forum bridge: the edited category's bridge, the forum channels
    // to pick from, and which categories are bridged (for the table badges).
    const bridgeEnabled = Boolean(features.discord?.forumBridge);
    let bridge = null;
    let bridgeStats = null;
    let forumChannels = { available: false, channels: [] };
    let bridgedCategoryIds = [];
    try {
      const bridges = await listBridges({ enabledOnly: true });
      bridgedCategoryIds = bridges.map((b) => b.categoryId);
      if (categoryToEdit) {
        bridge = await getBridgeByCategoryId(categoryToEdit.categoryId, { enabledOnly: false });
        if (bridge) bridgeStats = await getOutboxStats(categoryToEdit.categoryId);
        if (bridgeEnabled) {
          const { listForumChannels } = await import("../../lib/forums/forumBridgeSetup.mjs");
          forumChannels = await listForumChannels();
        }
      }
    } catch (error) {
      console.error("[DASHBOARD] Failed to load forum bridge info", error);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forums/categories", {
      pageTitle: `Dashboard - Forum Categories`,
      config,
      features,
      req,
      categories: categoryTree.tree,
      flatCategories: categoryTree.flat,
      categoryToEdit,
      createUnderId,
      globalImage,
      announcementWeb,
      bridgeEnabled,
      bridge,
      bridgeStats,
      forumChannels,
      bridgedCategoryIds,
      linkedRoleConfigured: Boolean(config.discord?.roles?.linked),
    }));
    return;
  });

  app.post("/dashboard/forums/categories/new", async function (req, res) {
    const hasAccess = await hasPermission(
      MANAGE_PERMISSION,
      req,
      res,
      features
    );
    if (!hasAccess) return;

    const name = (req.body.name || "").trim();
    const slug = (req.body.slug || "").trim() || null;
    const description = (req.body.description || "").trim() || null;
    const position = Number.parseInt(req.body.position, 10) || 0;
    const parentCategoryId = req.body.parentCategoryId
      ? Number.parseInt(req.body.parentCategoryId, 10)
      : null;
    const viewPermission = (req.body.viewPermission || "").trim() || null;
    const postPermission = (req.body.postPermission || "").trim() || null;

    if (!name) {
      setBannerCookie("danger", "A category name is required.", res);
      return res.redirect("/dashboard/forums/categories");
    }

    try {
      await createCategory({
        name,
        slug,
        description,
        position,
        parentCategoryId: parentCategoryId || null,
        viewPermission,
        postPermission,
      });

      setBannerCookie("success", "Category created.", res);
    } catch (error) {
      console.error("[DASHBOARD] Failed to create forum category", error);
      setBannerCookie(
        "danger",
        "Unable to create the category. Please try again.",
        res
      );
    }

    return res.redirect("/dashboard/forums/categories");
  });

  app.post(
      "/dashboard/forums/categories/:categoryId/edit",
    async function (req, res) {
      const hasAccess = await hasPermission(
        MANAGE_PERMISSION,
        req,
        res,
        features
      );
      if (!hasAccess) return;

      const categoryId = Number.parseInt(req.params.categoryId, 10);
      const existing = await getCategoryById(categoryId);

      if (!existing) {
        setBannerCookie("danger", "Category not found.", res);
        return res.redirect("/dashboard/forums/categories");
      }

      const name = (req.body.name || "").trim();
      const slug = (req.body.slug || "").trim() || null;
      const description = (req.body.description || "").trim() || null;
      const position = Number.parseInt(req.body.position, 10) || 0;
      const rawParent = req.body.parentCategoryId
        ? Number.parseInt(req.body.parentCategoryId, 10)
        : null;
      const parentCategoryId = rawParent === categoryId ? null : rawParent;
      const viewPermission = (req.body.viewPermission || "").trim() || null;
      const postPermission = (req.body.postPermission || "").trim() || null;

      // A descendant as parent makes a cycle, and categories in a cycle drop
      // out of both trees (only parentless rows are roots).
      if (parentCategoryId) {
        const seen = new Set();
        let cursor = parentCategoryId;
        while (cursor && !seen.has(cursor)) {
          if (cursor === categoryId) {
            setBannerCookie("danger", "A category cannot be moved under one of its own subcategories.", res);
            return res.redirect(`/dashboard/forums/categories?edit=${categoryId}`);
          }
          seen.add(cursor);
          const node = await getCategoryById(cursor);
          cursor = node?.parentCategoryId ? Number(node.parentCategoryId) : null;
        }
      }

      try {
        await updateCategory(categoryId, {
          name,
          slug,
          description,
          position,
          parentCategoryId,
          viewPermission,
          postPermission,
        });

        setBannerCookie("success", "Category updated.", res);
      } catch (error) {
        console.error("[DASHBOARD] Failed to update forum category", error);
        setBannerCookie(
          "danger",
          "Unable to update the category.",
          res
        );
      }

      return res.redirect(`/dashboard/forums/categories?edit=${categoryId}`);
    }
  );

  // Connect / disconnect a category and a Discord forum channel.
  app.post(
    "/dashboard/forums/categories/:categoryId/bridge",
    async function (req, res) {
      const hasAccess = await hasPermission(MANAGE_PERMISSION, req, res, features);
      if (!hasAccess) return;

      const categoryId = Number.parseInt(req.params.categoryId, 10);
      const back = `/dashboard/forums/categories?edit=${categoryId}`;
      const existing = await getCategoryById(categoryId);
      if (!existing) {
        setBannerCookie("danger", "Category not found.", res);
        return res.redirect("/dashboard/forums/categories");
      }

      if (!features.discord?.forumBridge) {
        setBannerCookie("warning", "Turn on the Forum ↔ Discord bridge under Modules first.", res);
        return res.redirect(back);
      }

      const action = String(req.body.action || "");
      try {
        const setup = await import("../../lib/forums/forumBridgeSetup.mjs");
        if (action === "disconnect") {
          await setup.disconnectCategory(categoryId);
          setBannerCookie("success", "Discord bridge turned off for this category. Nothing is deleted.", res);
          return res.redirect(back);
        }

        const channelId = String(req.body.channelId || "").trim();
        if (!/^\d{15,25}$/.test(channelId)) {
          setBannerCookie("danger", "Pick a Discord forum channel.", res);
          return res.redirect(back);
        }

        const result = await setup.connectCategoryToChannel(categoryId, channelId);
        if (!result.ok) {
          setBannerCookie("danger", result.error || "Couldn't connect the Discord channel.", res);
        } else if (result.warnings.length) {
          setBannerCookie("warning", `Bridged, with warnings: ${result.warnings.join(" ")}`, res);
        } else {
          setBannerCookie("success", "Bridged. New posts in this category and the Discord channel now sync both ways.", res);
        }
      } catch (error) {
        console.error("[DASHBOARD] Failed to update forum bridge", error);
        setBannerCookie("danger", "Couldn't update the Discord bridge.", res);
      }
      return res.redirect(back);
    }
  );

  app.post(
      "/dashboard/forums/categories/:categoryId/delete",
    async function (req, res) {
      const hasAccess = await hasPermission(
        MANAGE_PERMISSION,
        req,
        res,
        features
      );
      if (!hasAccess) return;

      const categoryId = Number.parseInt(req.params.categoryId, 10);
      const existing = await getCategoryById(categoryId);

      if (!existing) {
        setBannerCookie("danger", "Category not found.", res);
        return res.redirect("/dashboard/forums/categories");
      }

      try {
        await deleteCategory(categoryId);
        setBannerCookie("success", "Category deleted.", res);
      } catch (error) {
        console.error("[DASHBOARD] Failed to delete forum category", error);
        setBannerCookie(
          "danger",
          "Unable to delete the category.",
          res
        );
      }

      return res.redirect("/dashboard/forums/categories");
    }
  );
}
