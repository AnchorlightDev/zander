/**
 * routes/dashboard/pages.js
 *
 * Dashboard editor for custom pages (served at /<slug> by
 * routes/customPageRoutes.js).
 *
 *   GET  /dashboard/pages               — page list
 *   GET  /dashboard/pages/create        — new page form
 *   GET  /dashboard/pages/:id/edit      — edit form
 *   POST /dashboard/pages               — create
 *   POST /dashboard/pages/:id           — save
 *   POST /dashboard/pages/:id/delete    — delete
 */

import { getGlobalImage, hasPermission, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  createPage,
  deletePage,
  getPageById,
  isSlugUsedByAnotherPage,
  listPages,
  updatePage,
} from "../../controllers/customPageController.js";
import { refreshNavigationCache } from "../../controllers/navigationController.js";
import { PAGE_LIMITS, parsePageForm } from "../../lib/customPages.mjs";
import { PAGES_PERMISSION } from "../customPageRoutes.js";

export default function dashboardPagesRoute(app, config, db, features, lang) {
  /** True when a registered route already answers GET /<slug>. */
  const isRouteTaken = (slug) => app.hasRoute({ method: "GET", url: `/${slug}` });

  async function renderEditor(req, res, page, errors = []) {
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/pages/edit", {
        pageTitle: page?.pageId ? "Dashboard - Edit Page" : "Dashboard - New Page",
        config,
        req,
        features,
        page,
        errors,
        limits: PAGE_LIMITS,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
  }

  async function validate(body, pageId = null) {
    const parsed = parsePageForm(body, isRouteTaken);
    if (parsed.ok && (await isSlugUsedByAnotherPage(parsed.value.slug, pageId))) {
      return { ok: false, errors: [`Another page already uses /${parsed.value.slug}.`] };
    }
    return parsed;
  }

  app.get("/dashboard/pages", async function (req, res) {
    if (!(await hasPermission(PAGES_PERMISSION, req, res, features))) return;

    let pages = [];
    let error = null;
    try {
      pages = await listPages();
    } catch (err) {
      console.error("[dashboard/pages] failed to list pages:", err);
      error = "Could not load pages from the database.";
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/pages/index", {
        pageTitle: "Dashboard - Pages",
        config,
        req,
        features,
        pages,
        error,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
  });

  app.get("/dashboard/pages/create", async function (req, res) {
    if (!(await hasPermission(PAGES_PERMISSION, req, res, features))) return;
    return renderEditor(req, res, null);
  });

  app.get("/dashboard/pages/:id/edit", async function (req, res) {
    if (!(await hasPermission(PAGES_PERMISSION, req, res, features))) return;

    const page = await getPageById(req.params.id);
    if (!page) {
      setBannerCookie("danger", "That page no longer exists.", res);
      return res.redirect("/dashboard/pages");
    }
    return renderEditor(req, res, page);
  });

  app.post("/dashboard/pages", async function (req, res) {
    if (!(await hasPermission(PAGES_PERMISSION, req, res, features))) return;

    const parsed = await validate(req.body);
    if (!parsed.ok) return renderEditor(req, res, { ...req.body, pageId: null }, parsed.errors);

    const page = await createPage(parsed.value, req.session?.user?.userId);
    await refreshNavigationCache();
    console.log(`[dashboard/pages] ${req.session?.user?.username} created /${page.slug}`);
    setBannerCookie("success", `Page created${page.status === "published" ? ` and published at /${page.slug}` : " as a draft"}.`, res);
    return res.redirect(`/dashboard/pages/${page.pageId}/edit`);
  });

  app.post("/dashboard/pages/:id", async function (req, res) {
    if (!(await hasPermission(PAGES_PERMISSION, req, res, features))) return;

    const existing = await getPageById(req.params.id);
    if (!existing) {
      setBannerCookie("danger", "That page no longer exists.", res);
      return res.redirect("/dashboard/pages");
    }

    const parsed = await validate(req.body, existing.pageId);
    if (!parsed.ok) return renderEditor(req, res, { ...req.body, pageId: existing.pageId }, parsed.errors);

    await updatePage(existing.pageId, parsed.value, req.session?.user?.userId);
    await refreshNavigationCache();
    console.log(`[dashboard/pages] ${req.session?.user?.username} saved /${parsed.value.slug}`);
    setBannerCookie("success", "Page saved.", res);
    return res.redirect(`/dashboard/pages/${existing.pageId}/edit`);
  });

  app.post("/dashboard/pages/:id/delete", async function (req, res) {
    if (!(await hasPermission(PAGES_PERMISSION, req, res, features))) return;

    const existing = await getPageById(req.params.id);
    if (existing) {
      await deletePage(existing.pageId);
      await refreshNavigationCache();
      console.log(`[dashboard/pages] ${req.session?.user?.username} deleted /${existing.slug}`);
      setBannerCookie("success", `Deleted /${existing.slug}. Menu links to it are hidden until you remove them.`, res);
    }
    return res.redirect("/dashboard/pages");
  });
}
