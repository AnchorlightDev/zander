import {
  hasPermission,
  isFeatureWebRouteEnabled,
} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { prisma } from "../../controllers/databaseController.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";

export default function dashboardServersSiteRoute(
  app,
  fetch,
  config,
  db,
  features,
  lang
) {
  //
  // Servers list
  //
  app.get("/dashboard/servers", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission("zander.web.server", req, res, features)) return;

    // Direct Prisma query — no internal HTTP fetch.
    const [servers, announcementWeb] = await Promise.all([
      prisma.servers.findMany({ orderBy: { position: "asc" } }),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/servers/server-list", {
        pageTitle: "Servers",
        config,
        // Provide the same shape legacy template expected from apiData.
        apiData: { success: true, data: servers },
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Create server
  //
  app.get("/dashboard/servers/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission("zander.web.server", req, res, features)) return;

    const announcementWeb = await getWebAnnouncement();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/servers/server-editor", {
        pageTitle: "Create Server",
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
  // Edit server
  //
  app.get("/dashboard/servers/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission("zander.web.server", req, res, features)) return;

    const id = Number(req.query.id);

    const [server, announcementWeb] = await Promise.all([
      id ? prisma.servers.findUnique({ where: { serverId: id } }) : Promise.resolve(null),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/servers/server-editor", {
        pageTitle: "Edit Server",
        config,
        serverApiData: server,
        type: "edit",
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });
}
