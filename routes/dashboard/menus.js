/**
 * routes/dashboard/menus.js
 *
 * WordPress-style menu editor for the top bar, header and footer.
 *
 *   GET  /dashboard/menus?location=header  — edit one menu
 *   POST /dashboard/menus/:location        — save it (items arrive as JSON)
 *   POST /dashboard/menus/:location/reset  — go back to the built-in default
 *
 * What an item is and how a menu is validated: lib/navigation/menus.mjs.
 * Storage and the render cache: controllers/navigationController.js.
 */

import { createRequire } from "module";
import { getGlobalImage, hasPermission, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { listPublishedPages } from "../../controllers/customPageController.js";
import { getMenuItems, isMenuCustomised, resetMenu, saveMenu } from "../../controllers/navigationController.js";
import { describeFlags, listFlagPaths } from "../../lib/config/featureRegistry.mjs";
import { BUILTIN_LINKS, MENU_LOCATIONS, parseMenu } from "../../lib/navigation/menus.mjs";

const require = createRequire(import.meta.url);
const { DEFAULT_FEATURES } = require("../../lib/config/defaults.cjs");

const PERMISSION_NODE = "zander.web.menus";

export default function dashboardMenusRoute(app, config, db, features, lang) {
  app.get("/dashboard/menus", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const location = Object.hasOwn(MENU_LOCATIONS, String(req.query?.location ?? "")) ? req.query.location : "header";

    let pages = [];
    try {
      pages = await listPublishedPages();
    } catch (error) {
      console.error("[dashboard/menus] Could not list pages:", error);
    }

    const moduleFlags = describeFlags(features).flatMap((group) =>
      group.flags.map((flag) => ({ path: flag.path, label: `${group.title}: ${flag.label}` }))
    );

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/menus/index", {
        pageTitle: "Dashboard - Menus",
        config,
        req,
        features,
        location,
        locations: MENU_LOCATIONS,
        items: getMenuItems(location),
        customised: isMenuCustomised(location),
        pages: pages.map((p) => ({ pageId: p.pageId, title: p.title, slug: p.slug })),
        builtinLinks: BUILTIN_LINKS,
        moduleFlags,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
  });

  app.post("/dashboard/menus/:location", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const location = String(req.params.location || "");
    const back = `/dashboard/menus?location=${encodeURIComponent(location)}`;

    let raw;
    try {
      raw = JSON.parse(String(req.body?.items ?? ""));
    } catch {
      setBannerCookie("danger", "Nothing was saved: the menu could not be read. Reload the page and try again.", res);
      return res.redirect(back);
    }

    const featurePaths = new Set([...listFlagPaths(DEFAULT_FEATURES), ...listFlagPaths(features)]);
    const parsed = parseMenu(location, raw, { featurePaths });
    if (!parsed.ok) {
      setBannerCookie("danger", `Nothing was saved. ${parsed.errors.slice(0, 5).join(" ")}`, res);
      return res.redirect(back);
    }

    try {
      await saveMenu(location, parsed.items, req.session?.user?.userId);
      console.log(`[dashboard/menus] ${req.session?.user?.username} saved the ${location} menu`);
      setBannerCookie("success", `${MENU_LOCATIONS[location].label} menu saved.`, res);
    } catch (error) {
      console.error("[dashboard/menus] save failed:", error);
      setBannerCookie("danger", "Could not save the menu. Please try again.", res);
    }
    return res.redirect(back);
  });

  app.post("/dashboard/menus/:location/reset", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const location = String(req.params.location || "");
    if (!Object.hasOwn(MENU_LOCATIONS, location)) return res.redirect("/dashboard/menus");

    try {
      await resetMenu(location);
      setBannerCookie("success", `${MENU_LOCATIONS[location].label} menu reset to the default.`, res);
    } catch (error) {
      console.error("[dashboard/menus] reset failed:", error);
      setBannerCookie("danger", "Could not reset the menu. Please try again.", res);
    }
    return res.redirect(`/dashboard/menus?location=${location}`);
  });
}
