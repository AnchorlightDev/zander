import { getMenuGroups } from "../../admin/pageRegistry.js";
import { getUserPermissions } from "../../controllers/userController.js";
import { isSessionPermissionsInvalidated } from "../../controllers/rankSyncController.js";

import dashboardSiteRoute from "./dashboard.js";
import dashboardServersSiteRoute from "./servers.js";
import dashboardApplicationsSiteRoute from "./applications.js";
import dashboardAnnouncementSiteRoute from "./announcement.js";
import dashboardVaultSiteRoute from "./vault.js";
import dashboardRanksSiteRoute from "./ranks.js";
import dashboardForumsSiteRoute from "./forums.js";
import supportDashboardRoutes from "./support.js";
import dashboardSchedulerSiteRoute from "./scheduler.js";
import dashboardWebPunishmentsRoute from "./webPunishments.js";
import dashboardEventsRoute from "./events.js";
import dashboardBadgesRoute from "./badges.js";
import dashboardUsersRoute from "./users.js";
import dashboardFinanceRoute from "./finance.js";
import dashboardWebstoreRoute from "./webstore.js";
import dashboardRankCatalogRoute from "./rankCatalog.js";
import dashboardWebstoreCategoriesRoute from "./webstoreCategories.js";
import dashboardWebstoreProductsRoute from "./webstoreProducts.js";
import dashboardApiClientsRoute from "./apiClients.js";
import dashboardSettingsRoute from "./settings.js";
import dashboardModulesRoute from "./modules.js";
import dashboardFormsRoute from "./forms.js";
import dashboardPagesRoute from "./pages.js";
import dashboardMenusRoute from "./menus.js";
import dashboardResourcesRoute from "./resources.js";
import { hasStaffFlag } from "../../lib/permissions/staffFlag.mjs";

export default function dashboardSiteRoutes(
  app,
  client,
  fetch,
  moment,
  config,
  db,
  features,
  lang
) {
  const PERMISSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const PERMISSION_REFRESH_DEADLINE_MS = 2500;

  // A refresh that missed its deadline keeps running here, and the next
  // request from the same person picks up the result.
  const pendingRefreshes = new Map(); // userId -> { promise, result }

  /**
   * Fresh permissions from LuckPerms, or null when they are not ready within
   * the deadline. LuckPerms is a separate database; a slow or stalled
   * connection to it must never hold a page (that showed as a white page on
   * the first dashboard load until a refresh).
   */
  async function refreshWithinDeadline(user) {
    const key = user.userId;
    let entry = pendingRefreshes.get(key);
    if (entry?.result) {
      pendingRefreshes.delete(key);
      return entry.result;
    }
    if (!entry) {
      entry = {};
      entry.promise = getUserPermissions({ userId: user.userId, username: user.username, uuid: user.uuid })
        .then((permissions) => { entry.result = permissions; return permissions; })
        .catch((error) => {
          pendingRefreshes.delete(key);
          console.error("[PERMISSIONS] Background permission refresh failed:", error.message);
          return null;
        });
      pendingRefreshes.set(key, entry);
    }

    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PERMISSION_REFRESH_DEADLINE_MS); });
    const permissions = await Promise.race([entry.promise, deadline]);
    clearTimeout(timer);
    if (permissions) {
      pendingRefreshes.delete(key);
      return permissions;
    }
    console.warn(`[PERMISSIONS] Permission refresh for user ${key} is slow; serving the page with current permissions.`);
    return null;
  }

  async function refreshSessionPermissions(req) {
    if (!req.session?.user?.userId) {
      return;
    }

    const lastRefreshedAt = Number(req.session.user.permissionsRefreshedAt || 0);
    const isStale = !lastRefreshedAt
      || (Date.now() - lastRefreshedAt) > PERMISSION_REFRESH_INTERVAL_MS
      || isSessionPermissionsInvalidated(req.session.user.uuid, lastRefreshedAt);
    if (!isStale) {
      return;
    }

    const refreshedPermissions = await refreshWithinDeadline(req.session.user);
    if (!refreshedPermissions) return; // still loading: keep the current permissions for this page
    const rankSlugs = refreshedPermissions.userRanks || [];

    req.session.user.permissions = refreshedPermissions;
    req.session.user.ranks = rankSlugs.map((rankSlug) => ({ rankSlug }));
    req.session.user.isStaff = hasStaffFlag(refreshedPermissions);
    req.session.user.permissionsRefreshedAt = Date.now();
  }

  /**
   * Keep every logged-in session's permissions current (rank changes made on the website apply on
   * the next request; changes made elsewhere within PERMISSION_REFRESH_INTERVAL_MS), and attach
   * admin menu data to every /dashboard/* request so that _sidebar.ejs can read it from
   * req.adminMenuGroups without requiring each route handler to pass it explicitly.
   *
   * This hook runs after session parsing, so req.session.user is available.
   */
  app.addHook("preHandler", async (req) => {
    try {
      await refreshSessionPermissions(req);
    } catch (error) {
      // Keep serving with the cached permissions rather than failing the request.
      console.error("[PERMISSIONS] Failed to refresh session permissions:", error);
    }
    if (req.url && req.url.startsWith("/dashboard")) {
      const perms = req.session?.user?.permissions ?? [];
      req.adminMenuGroups = getMenuGroups(perms, features);
    }
  });

  // ── Route modules ─────────────────────────────────────────────────────────
  supportDashboardRoutes(app, client, fetch, moment, config, db, features, lang);
  dashboardSiteRoute(app, config, features, lang);
  dashboardServersSiteRoute(app, fetch, config, db, features, lang);
  dashboardAnnouncementSiteRoute(app, fetch, config, db, features, lang);
  dashboardApplicationsSiteRoute(app, fetch, config, db, features, lang);
  dashboardVaultSiteRoute(app, fetch, config, db, features, lang);
  dashboardRanksSiteRoute(app, fetch, config, db, features, lang);
  dashboardForumsSiteRoute(app, fetch, config, db, features, lang);
  dashboardSchedulerSiteRoute(app, client, fetch, config, features, lang);
  dashboardWebPunishmentsRoute(app, client, fetch, config, db, features, lang);
  dashboardEventsRoute(app, fetch, config, db, features, lang);
  dashboardBadgesRoute(app, fetch, config, db, features, lang);
  dashboardUsersRoute(app, fetch, config, db, features, lang);
  dashboardFinanceRoute(app, fetch, config, db, features, lang);
  dashboardWebstoreRoute(app, fetch, config, db, features, lang);
  dashboardRankCatalogRoute(app, config, db, features, lang);
  dashboardWebstoreCategoriesRoute(app, config, db, features, lang);
  dashboardWebstoreProductsRoute(app, config, db, features, lang);
  dashboardApiClientsRoute(app, config, db, features, lang);
  dashboardSettingsRoute(app, config, db, features, lang);
  dashboardModulesRoute(app, config, db, features, lang);
  dashboardFormsRoute(app, config, db, features, lang);
  dashboardPagesRoute(app, config, db, features, lang);
  dashboardMenusRoute(app, config, db, features, lang);
  dashboardResourcesRoute(app, config, db, features, lang);
}
