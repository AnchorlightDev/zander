/**
 * routes/dashboard/modules.js
 *
 * Switch modules (feature flags, stored in the database) on and off.
 *
 *   GET  /dashboard/modules  — every flag, grouped, with its current state
 *   POST /dashboard/modules  — save all toggles
 *
 * The flag list comes from the defaults (lib/config/defaults.cjs) plus any
 * imported legacy features.json (lib/config/featureRegistry.mjs);
 * storage and the live overlay are in controllers/configSettingsController.js.
 */

import { getGlobalImage, hasPermission, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { describeFeatureFlags, saveFeatureFlags } from "../../controllers/configSettingsController.js";
import { hasModuleSettings } from "../../lib/config/settingsRegistry.mjs";
import { hasPermission as holdsNode } from "../../lib/discord/permissions.mjs";

const PERMISSION_NODE = "zander.web.modules";

export default function dashboardModulesRoute(app, config, db, features, lang) {
  app.get("/dashboard/modules", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    let groups = [];
    let error = null;
    try {
      groups = await describeFeatureFlags();
    } catch (err) {
      console.error("[dashboard/modules] failed to load flags:", err);
      error = "Could not load module settings from the database.";
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/modules/index", {
        pageTitle: "Dashboard - Modules",
        config,
        req,
        features,
        groups,
        error,
        hasModuleSettings,
        canEditSettings: holdsNode(req.session?.user?.permissions, "zander.web.settings"),
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
  });

  app.post("/dashboard/modules", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    try {
      const { changed } = await saveFeatureFlags(req.body ?? {});
      const actor = req.session?.user?.username || req.session?.user?.userId || "unknown";
      console.log(
        `[dashboard/modules] ${actor} saved modules; differing from default: ${changed.join(", ") || "none"}`
      );
      setBannerCookie("success", "Modules saved.", res);
    } catch (err) {
      console.error("[dashboard/modules] save failed:", err);
      setBannerCookie("danger", "Could not save modules. Please try again.", res);
    }
    return res.redirect("/dashboard/modules");
  });
}
