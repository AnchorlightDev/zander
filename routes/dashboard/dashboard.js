import { hasPermission, internalApiHeaders} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { prisma } from "../../controllers/databaseController.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import moment from "moment";

export default function dashboardSiteRoute(app, config, features, lang) {
  //
  // Dashboard home
  //
  app.get("/dashboard", async function (req, res) {
    if (!await hasPermission("zander.web.dashboard", req, res, features)) return;

    // Fetch summary counts + recent data directly via Prisma — no self-HTTP.
    const [
      announcementsCount,
      applicationsCount,
      serversCount,
      recentAnnouncements,
      announcementWeb,
    ] = await Promise.all([
      prisma.announcements.count(),
      prisma.applications.count(),
      prisma.servers.count(),
      prisma.announcements.findMany({
        orderBy: { announcementId: "desc" },
        take: 5,
        select: {
          announcementId: true,
          announcementType: true,
          colourMessageFormat: true,
          body: true,
          enabled: true,
          startDate: true,
          endDate: true,
        },
      }),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/dashboard-index", {
        pageTitle: "Dashboard",
        config,
        features,
        req,
        announcementWeb,
        announcementsCount,
        applicationsCount,
        serversCount,
        recentAnnouncements,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Logs
  //
  app.get("/dashboard/logs", async function (req, res) {
    if (!await hasPermission("zander.web.logs", req, res, features)) return;

    // Build query-string for the logs API (still fetches via internal HTTP
    // because the logs controller uses raw cross-database queries that are
    // not yet fully wrapped in Prisma).
    const params = new URLSearchParams();
    if (req.query?.user)    params.set("user",    req.query.user);
    if (req.query?.feature) params.set("feature", req.query.feature);

    let apiData = { data: [] };
    try {
      const qs  = params.toString() ? `?${params.toString()}` : "";
      const url = `${process.env.siteAddress}/api/web/logs/get${qs}`;
      const r   = await fetch(url, { headers: internalApiHeaders() });
      apiData   = await r.json();
    } catch (err) {
      console.error("[dashboard/logs] fetch failed:", err.message);
    }

    const announcementWeb = await getWebAnnouncement();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/logs", {
        pageTitle: "Dashboard - Logs",
        config,
        apiData,
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Bridge processor
  //
  app.get("/dashboard/bridge", async function (req, res) {
    if (!await hasPermission("zander.web.bridge", req, res, features)) return;

    let pendingTasks    = { data: [] };
    let processingTasks = { data: [] };
    let routines        = { data: [] };

    try {
      const base    = process.env.siteAddress;
      const headers = internalApiHeaders();

      const [pr, cr, rr] = await Promise.all([
        fetch(`${base}/api/bridge/processor/get?status=pending&limit=100`,    { headers }),
        fetch(`${base}/api/bridge/processor/get?status=processing&limit=100`, { headers }),
        fetch(`${base}/api/bridge/routine/get`,                               { headers }),
      ]);

      [pendingTasks, processingTasks, routines] = await Promise.all([
        pr.json().catch(() => ({ data: [] })),
        cr.json().catch(() => ({ data: [] })),
        rr.json().catch(() => ({ data: [] })),
      ]);
    } catch (err) {
      console.error("[dashboard/bridge] fetch failed:", err.message);
    }

    const announcementWeb = await getWebAnnouncement();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/bridge", {
        pageTitle: "Dashboard - Bridge",
        config,
        pendingTasks,
        processingTasks,
        routines,
        pendingList: pendingTasks?.data || [],
        processingList: processingTasks?.data || [],
        routinesList: routines?.data || [],
        moment,
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });
}
