/**
 * routes/dashboard/settings.js
 *
 * Dashboard editor for the site settings (stored in the database).
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
  findModuleSection,
  findSection,
  isSecretField,
  maskSecret,
} from "../../lib/config/settingsRegistry.mjs";
import { describeFlags } from "../../lib/config/featureRegistry.mjs";
import { getBotGuilds, getGuildDirectory } from "../../services/discordDirectoryService.js";

/** The settings for one module, titled with its label from the Modules page. */
function moduleSectionFor(key, features) {
  const flagPath = String(key).slice("module:".length);
  const flag = describeFlags(features).flatMap((g) => g.flags).find((f) => f.path === flagPath);
  return flag ? findModuleSection(flagPath, flag.label) : null;
}

const PERMISSION_NODE = "zander.web.settings";

export default function dashboardSettingsRoute(app, config, db, features, lang) {
  app.get("/dashboard/settings", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const requested = String(req.query?.section || "");
    const section = (requested.startsWith("module:") ? moduleSectionFor(requested, features) : findSection(requested)) || SETTINGS_SECTIONS[0];

    // Channel / category / role pickers need the server's list; skip the
    // Discord round trip for sections without any.
    const picks = new Set(section.fields.map((f) => f.pick).filter(Boolean));
    let discordDirectory = null;
    if (picks.size) {
      const guilds = picks.has("guild") ? getBotGuilds() : null;
      const lists = [...picks].some((p) => p !== "guild") ? await getGuildDirectory(config.discord?.guildId) : null;
      if (guilds || lists) discordDirectory = { channels: [], categories: [], roles: [], ...(lists || {}), guilds: guilds || [] };
      // A list that could not be loaded falls back to the ID box for that kind only.
      if (discordDirectory) discordDirectory.loaded = { guild: Boolean(guilds), channel: Boolean(lists), category: Boolean(lists), role: Boolean(lists) };
    }

    let values = {};
    let error = null;
    try {
      values = await describeSettings();
    } catch (err) {
      console.error("[dashboard/settings] failed to load settings:", err);
      error = "Could not load saved settings from the database. Values shown are the defaults.";
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
        discordDirectory,
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
