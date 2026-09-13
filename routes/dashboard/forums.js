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
