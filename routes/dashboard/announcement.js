import {
  hasPermission,
  isFeatureWebRouteEnabled,
} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { prisma } from "../../controllers/databaseController.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";

export default function dashboardAnnouncementSiteRoute(
  app,
  fetch,
  config,
  db,
  features,
  lang
) {
  //
  // Announcements list
  //
  app.get("/dashboard/announcements", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.announcements, req, res, features)) return;
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;

    // Direct Prisma query — no internal HTTP fetch.
    const [announcements, announcementWeb] = await Promise.all([
      prisma.announcements.findMany({
        orderBy: { announcementId: "desc" },
      }),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/announcements/announcements-list", {
        pageTitle: "Announcements",
        config,
        // Provide the same shape the template historically expected via apiData.
        apiData: { success: true, data: announcements },
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Create announcement
  //
  app.get("/dashboard/announcements/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.announcements, req, res, features)) return;
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;

    const announcementWeb = await getWebAnnouncement();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/announcements/announcements-editor", {
        pageTitle: "Create Announcement",
        config,
        type: "create",
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Edit announcement
  //
  app.get("/dashboard/announcements/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.announcements, req, res, features)) return;
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;

    const announcementId = Number(req.query.announcementId);

    const [announcement, announcementWeb] = await Promise.all([
      announcementId
        ? prisma.announcements.findUnique({ where: { announcementId } })
        : Promise.resolve(null),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/announcements/announcements-editor", {
        pageTitle: "Edit Announcement",
        config,
        announcementApiData: announcement,
        type: "edit",
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });
}
