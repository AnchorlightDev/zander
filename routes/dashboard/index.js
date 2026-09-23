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
import dashboardApiClientsRoute from "./apiClients.js";
import dashboardFormsRoute from "./forms.js";

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

    const refreshedPermissions = await getUserPermissions({
      userId: req.session.user.userId,
      username: req.session.user.username,
      uuid: req.session.user.uuid,
    });
    const rankSlugs = refreshedPermissions.userRanks || [];

    req.session.user.permissions = refreshedPermissions;
    req.session.user.ranks = rankSlugs.map((rankSlug) => ({ rankSlug }));
    req.session.user.isStaff = refreshedPermissions.some(
      (permission) => permission && String(permission).trim().toLowerCase().startsWith("meta.staff.")
    );
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
  dashboardApiClientsRoute(app, config, db, features, lang);
  dashboardFormsRoute(app, config, db, features, lang);
}
