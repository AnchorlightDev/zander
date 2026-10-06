import { hasPermission, internalApiHeaders} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { prisma, isDbHealthy } from "../../controllers/databaseController.js";
import { client } from "../../controllers/discordController.js";
import { buildOverview, greetingFor, stripMinecraftFormatting } from "../../lib/dashboard/overview.mjs";
import { formatPrice } from "../../controllers/webstoreController.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import moment from "moment";

export default function dashboardSiteRoute(app, config, features, lang) {
  //
  // Dashboard home
  //
  app.get("/dashboard", async function (req, res) {
    if (!await hasPermission("zander.web.dashboard", req, res, features)) return;

    // Each number is read on its own: one failing query drops its tile rather
    // than the whole page. lib/dashboard/overview.mjs decides what is shown.
    const count = (promise) => promise.catch((error) => {
      console.error("[dashboard] overview count failed:", error.message);
      return null;
    });
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [
      openTickets,
      eventsAwaitingReview,
      formSubmissions,
      resourceSuggestions,
      resourcesOverdue,
      failedCommands,
      members,
      newMembers,
      forumPosts,
      webstoreMonth,
      servers,
      recentAnnouncements,
      announcementWeb,
    ] = await Promise.all([
      count(prisma.supportTickets.count({ where: { status: { in: ["open", "in_progress"] } } })),
      count(prisma.events.count({ where: { status: "pending_review" } })),
      count(prisma.formSubmissions.count({ where: { status: "pending", form: { requiresReview: true } } })),
      count(prisma.resources.count({ where: { status: "pending" } })),
      count(prisma.resources.count({ where: { status: "pending", deadlineAt: { lte: now } } })),
      count(prisma.player_command_queue.count({ where: { status: "failed" } })),
      count(prisma.users.count()),
      count(prisma.users.count({ where: { joined: { gte: weekAgo } } })),
      count(prisma.forumPosts.count({ where: { createdAt: { gte: weekAgo } } })),
      // Per currency: purchases record their own, and they must not be added together.
      count(prisma.webstorePurchases.groupBy({
        by: ["currency"],
        where: { status: { in: ["paid", "fulfilled"] }, createdAt: { gte: monthStart } },
        _sum: { amountCents: true },
        _count: true,
      })),
      count(prisma.servers.count()),
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
      }).catch(() => []),
      getWebAnnouncement(),
    ]);

    const overview = buildOverview(
      {
        openTickets,
        eventsAwaitingReview,
        formSubmissions,
        resourceSuggestions,
        resourcesOverdue,
        failedCommands,
        members,
        newMembers,
        forumPosts,
        webstoreRevenue: webstoreMonth
          ? webstoreMonth.length
            ? webstoreMonth
                .sort((a, b) => (b._sum.amountCents ?? 0) - (a._sum.amountCents ?? 0))
                .map((row) => formatPrice(row._sum.amountCents ?? 0, row.currency))
                .join(" + ")
            : formatPrice(0, "aud")
          : null,
        webstoreOrders: webstoreMonth ? webstoreMonth.reduce((n, row) => n + row._count, 0) : null,
        servers,
      },
      { features, permissions: req.session.user.permissions || [] }
    );

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/dashboard-index", {
        pageTitle: "Dashboard",
        config,
        features,
        req,
        announcementWeb,
        overview,
        recentAnnouncements: recentAnnouncements.map((a) => ({
          ...a,
          preview: stripMinecraftFormatting(a.colourMessageFormat || a.body) || "(no text)",
        })),
        system: {
          discordOnline: Boolean(client?.isReady?.()),
          databaseOnline: isDbHealthy(),
        },
        greetingFor,
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
