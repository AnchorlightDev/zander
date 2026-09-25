/**
 * routes/dashboard/settings.js
 *
 * Dashboard editor for the staff-tunable parts of config.json.
 *
 *   GET  /dashboard/settings?section=general  — one section of the settings form
 *   POST /dashboard/settings/:section         — save that section
 *
 * Which fields exist, how each is validated, and which need a restart all
 * live in lib/config/settingsRegistry.mjs. Storage and the live overlay are
 * in controllers/configSettingsController.js.
 */

import { getGlobalImage, hasPermission, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { describeSettings, saveSection } from "../../controllers/configSettingsController.js";
import { groupedTimeZones } from "../../lib/timezones.mjs";
import {
  SETTINGS_SECTIONS,
  findSection,
  isSecretField,
  maskSecret,
} from "../../lib/config/settingsRegistry.mjs";

const PERMISSION_NODE = "zander.web.settings";

export default function dashboardSettingsRoute(app, config, db, features, lang) {
  app.get("/dashboard/settings", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const section = findSection(String(req.query?.section || "")) || SETTINGS_SECTIONS[0];

    let values = {};
    let error = null;
    try {
      values = await describeSettings();
    } catch (err) {
      console.error("[dashboard/settings] failed to load settings:", err);
      error = "Could not load saved settings from the database. Values shown are from config.json.";
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/settings/index", {
        pageTitle: "Dashboard - Site Settings",
        config,
        req,
        features,
        sections: SETTINGS_SECTIONS,
        section,
        values,
        error,
        isSecretField,
        maskSecret,
        timeZoneGroups: groupedTimeZones(),
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
  });

  app.post("/dashboard/settings/:section", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const sectionKey = String(req.params.section || "");
    const back = `/dashboard/settings?section=${encodeURIComponent(sectionKey)}`;
    const body = req.body ?? {};
    const rawResets = body.reset;
    const resets = Array.isArray(rawResets) ? rawResets : rawResets ? [rawResets] : [];

    try {
      const { saved, errors } = await saveSection(sectionKey, body, resets);
      if (errors.length) {
        setBannerCookie("danger", `Nothing was saved. ${errors.join(" ")}`, res);
      } else {
        const actor = req.session?.user?.username || req.session?.user?.userId || "unknown";
        console.log(`[dashboard/settings] ${actor} saved section "${sectionKey}" (${saved} field(s))`);
        setBannerCookie("success", "Settings saved.", res);
      }
    } catch (err) {
      console.error("[dashboard/settings] save failed:", err);
      setBannerCookie("danger", "Could not save settings. Please try again.", res);
    }
    return res.redirect(back);
  });
}
