/**
 * Dashboard Events Routes
 * Provides the admin-facing calendar, list, editor, template management, and approval UI.
 */

import {
  getGlobalImage,
  hasPermission,
  isFeatureWebRouteEnabled,
  setBannerCookie,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { hasPermission as hasPermissionNode } from "../../lib/discord/permissions.mjs";
import { getEventById } from "../../services/eventService.js";
import { enrichHostsWithAvatars } from "../../lib/avatarHelpers.js";

/** Fetch a URL with the internal API key and parse JSON, returning fallback on error. */
async function fetchJson(fetchFn, url, fallback = null) {
  try {
    const res = await fetchFn(url, {
      headers: { "x-access-token": process.env.apiKey },
    });
    return await res.json();
  } catch (error) {
    console.error(`[dashboard/events] fetchJson failed for ${url}:`, error.message);
    return fallback;
  }
}

export default function dashboardEventsSiteRoute(app, fetch, config, db, features, lang) {
  function userCanEditEvent(ev, req) {
    const userPerms = req.session.user?.permissions || [];
    const isCreator = ev.creatorId && ev.creatorId === req.session.user?.userId;
    const hasReview = hasPermissionNode(userPerms, "zander.web.events.review");
    const hasEdit = hasPermissionNode(userPerms, "zander.web.events.edit");

    // Once approved or published only reviewers may edit; draft/rejected allow editor or reviewer
    if (["approved", "published", "pending_review"].includes(ev.status)) {
      return hasReview;
    }
    return hasEdit || hasReview;
  }

  function userIsReviewer(req) {
    return hasPermissionNode(req.session.user?.permissions || [], "zander.web.events.review");
  }

  function userIsEditor(req) {
    const userPerms = req.session.user?.permissions || [];
    return hasPermissionNode(userPerms, "zander.web.events.edit") ||
           hasPermissionNode(userPerms, "zander.web.events.review");
  }
  // ============================================================================
  // Calendar View
  // ============================================================================
  app.get("/dashboard/events", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events", req, res, features)) return;

    const [globalImage, announcementWeb] = await Promise.all([
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-calendar", {
        pageTitle: "Dashboard - Events Calendar",
        config,
        features,
        req,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // List View
  // ============================================================================
  app.get("/dashboard/events/list", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events", req, res, features)) return;

    const statusFilter = req.query.status || "";
    const search = req.query.search || "";
    const showPast = req.query.showPast === "1";

    const DEFAULT_STATUSES = ["draft", "approved", "published"];

    let qs = "";
    if (statusFilter) {
      qs += `&status=${encodeURIComponent(statusFilter)}`;
    } else {
      qs += `&statuses=${encodeURIComponent(DEFAULT_STATUSES.join(","))}`;
    }
    if (!showPast) qs += "&hidePast=1";
    if (search) qs += `&search=${encodeURIComponent(search)}`;

    const fetchURL = `${process.env.siteAddress}/api/events/get?limit=100${qs}`;

    const [apiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(fetch, fetchURL, { data: [] }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    const userPerms = req.session.user?.permissions || [];
    const hasReviewPermission = hasPermissionNode(userPerms, "zander.web.events.review");
    const hasEditPermission = hasPermissionNode(userPerms, "zander.web.events.edit") || hasReviewPermission;

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-list", {
        pageTitle: "Dashboard - Events",
        config,
        features,
        req,
        apiData,
        statusFilter,
        search,
        showPast,
        hasReviewPermission,
        hasEditPermission,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // Approval Queue
  // ============================================================================
  app.get("/dashboard/events/review", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events.review", req, res, features)) return;

    const [apiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(fetch, `${process.env.siteAddress}/api/events/pending-review`, { data: [] }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-review", {
        pageTitle: "Dashboard - Event Review Queue",
        config,
        features,
        req,
        apiData,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // Create Event
  // ============================================================================
  app.get("/dashboard/events/create", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events.edit", req, res, features)) return;

    const [templatesData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(fetch, `${process.env.siteAddress}/api/events/templates/get`, { data: [] }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-editor", {
        pageTitle: "Dashboard - Create Event",
        config,
        features,
        req,
        mode: "create",
        ev: {},
        isPublished: false,
        apiEndpoint: "/api/events/create",
        templatesData,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // Edit Event
  // ============================================================================
  app.get("/dashboard/events/edit", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events.edit", req, res, features)) return;

    const eventId = req.query.eventId;
    if (!eventId) return res.redirect("/dashboard/events/list");

    const [apiData, templatesData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(fetch, `${process.env.siteAddress}/api/events/single?eventId=${eventId}`, null),
      fetchJson(fetch, `${process.env.siteAddress}/api/events/templates/get`, { data: [] }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    if (!apiData || !apiData.success) {
      setBannerCookie("danger", "Event not found", res);
      return res.redirect("/dashboard/events/list");
    }

    const ev = apiData.data;

    if (!userCanEditEvent(ev, req)) {
      const lockedMsg = ["approved", "published", "pending_review"].includes(ev.status)
        ? "This event is approved or live — only approvers can edit it."
        : "You can only edit your own events.";
      setBannerCookie("danger", lockedMsg, res);
      return res.redirect(`/dashboard/events/view?eventId=${ev.eventId}`);
    }

    const isPublished = ev.status === "published";

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-editor", {
        pageTitle: `Dashboard - Edit Event`,
        config,
        features,
        req,
        mode: "edit",
        ev,
        isPublished,
        apiEndpoint: isPublished ? "/api/events/update-published" : "/api/events/update",
        templatesData,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // View Event (read-only detail with audit log)
  // ============================================================================
  app.get("/dashboard/events/view", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events", req, res, features)) return;

    const eventId = req.query.eventId;
    if (!eventId) return res.redirect("/dashboard/events/list");

    const [apiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(fetch, `${process.env.siteAddress}/api/events/single?eventId=${eventId}`, null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    if (!apiData || !apiData.success) {
      setBannerCookie("danger", "Event not found", res);
      return res.redirect("/dashboard/events/list");
    }

    const ev = apiData.data;
    const statusColors = {
      draft: "secondary", pending_review: "warning", approved: "info",
      published: "success", rejected: "danger", cancelled: "purple", archived: "dark",
    };
    const badgeClass = statusColors[ev.status] || "secondary";
    const isReviewer = userIsReviewer(req);
    // userCanEditEvent already accounts for status; only exclude terminal states
    const canEdit = !["cancelled", "archived"].includes(ev.status) && userCanEditEvent(ev, req);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-view", {
        pageTitle: `Dashboard - ${ev.title}`,
        config,
        features,
        req,
        ev,
        badgeClass,
        canEdit,
        isReviewer,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // Templates List
  // ============================================================================
  app.get("/dashboard/events/templates", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events", req, res, features)) return;

    const [apiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(fetch, `${process.env.siteAddress}/api/events/templates/get`, { data: [] }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-templates", {
        pageTitle: "Dashboard - Event Templates",
        config,
        features,
        req,
        apiData,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // Create Template
  // ============================================================================
  app.get("/dashboard/events/templates/create", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events.edit", req, res, features)) return;

    const [globalImage, announcementWeb] = await Promise.all([
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-template-editor", {
        pageTitle: "Dashboard - Create Event Template",
        config,
        features,
        req,
        mode: "create",
        tmpl: {},
        dayNames: DAY_NAMES,
        recDays: [],
        globalImage,
        announcementWeb,
      })
    );
  });

  // ============================================================================
  // Preview Event (renders public template regardless of status)
  // ============================================================================
  app.get("/dashboard/events/preview", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events", req, res, features)) return;

    const eventId = req.query.eventId;
    if (!eventId) return res.redirect("/dashboard/events/list");

    try {
      const event = await getEventById(eventId);
      if (!event) {
        setBannerCookie("danger", "Event not found", res);
        return res.redirect("/dashboard/events/list");
      }

      if (!userCanEditEvent(event, req)) {
        setBannerCookie("danger", "You do not have permission to preview this event.", res);
        return res.redirect("/dashboard/events/list");
      }

      event.hosts = await enrichHostsWithAvatars(event.hosts || []);

      const startTs = Math.floor(new Date(event.startAt).getTime() / 1000);
      const endTs = Math.floor(new Date(event.endAt).getTime() / 1000);

      const gcalStart = new Date(event.startAt).toISOString().replace(/[-:]/g, "").replace(".000", "");
      const gcalEnd = new Date(event.endAt).toISOString().replace(/[-:]/g, "").replace(".000", "");
      const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(event.title)}&dates=${gcalStart}/${gcalEnd}&details=${encodeURIComponent((event.description || "").slice(0, 500))}&location=${encodeURIComponent(event.locationLabel || event.serverIp || "")}`;

      let tags = [];
      try { tags = Array.isArray(event.tags) ? event.tags : (event.tags ? JSON.parse(event.tags) : []); } catch { tags = []; }

      let externalLinks = [];
      try { externalLinks = Array.isArray(event.externalLinks) ? event.externalLinks : (event.externalLinks ? JSON.parse(event.externalLinks) : []); } catch { externalLinks = []; }

      const [globalImage, announcementWeb] = await Promise.all([
        getGlobalImage(),
        getWebAnnouncement(),
      ]);

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/events/events-detail", {
          pageTitle: `Preview: ${event.title}`,
          pageDescription: event.description ? event.description.replace(/<[^>]+>/g, "").slice(0, 200) : `${event.title} — Community event`,
          config,
          req,
          features,
          event,
          tags,
          externalLinks,
          startTs,
          endTs,
          gcalUrl,
          globalImage,
          announcementWeb,
          isPreview: true,
        })
      );
    } catch (err) {
      console.error("[Events] preview error:", err);
      setBannerCookie("danger", "Error loading event preview", res);
      return res.redirect("/dashboard/events/list");
    }
  });

  // ============================================================================
  // Edit Template
  // ============================================================================
  app.get("/dashboard/events/templates/edit", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;
    if (!await hasPermission("zander.web.events.edit", req, res, features)) return;

    const templateId = req.query.templateId;
    if (!templateId) return res.redirect("/dashboard/events/templates");

    const [apiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(fetch, `${process.env.siteAddress}/api/events/templates/single?templateId=${templateId}`, null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    if (!apiData || !apiData.success) {
      setBannerCookie("danger", "Template not found", res);
      return res.redirect("/dashboard/events/templates");
    }

    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const tmpl = apiData.data;

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/events/events-template-editor", {
        pageTitle: "Dashboard - Edit Event Template",
        config,
        features,
        req,
        mode: "edit",
        tmpl,
        dayNames: DAY_NAMES,
        recDays: (tmpl.recurrenceDays || []).map(Number),
        globalImage,
        announcementWeb,
      })
    );
  });
}
