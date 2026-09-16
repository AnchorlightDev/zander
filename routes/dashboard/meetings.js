/**
 * Dashboard Meetings Routes
 *
 * Admin-facing list, editor and response screens for the Meetings module.
 *
 * Unlike routes/dashboard/events.js these handlers call the service layer
 * directly rather than self-calling the JSON API.  A self-call authenticates
 * with INTERNAL_API_KEY, which the API treats as a trusted client with full
 * visibility — it carries none of the viewer's session, so every page would
 * render the manager's view of every poll regardless of who was looking.
 * Meetings are scoped per viewer (a plain invitee sees only their own), so the
 * viewer's userId has to be passed explicitly.  This matches the direct-Prisma
 * approach already used in routes/dashboard/dashboard.js.
 */

import {
  getGlobalImage,
  hasPermission,
  isFeatureWebRouteEnabled,
  isLoggedIn,
  setBannerCookie,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { hasPermission as hasPermissionNode } from "../../lib/discord/permissions.mjs";
import {
  getPolls,
  getPollById,
  isInvitee,
} from "../../services/meetingPollService.js";
import { listRankSlugs } from "../../services/meetingRosterService.js";

const MANAGE_NODE = "zander.web.meetings.manage";

export default function dashboardMeetingsSiteRoute(app, fetch, config, db, features, lang) {
  function userCanManage(req) {
    return hasPermissionNode(req.session?.user?.permissions || [], MANAGE_NODE);
  }

  /**
   * Meetings pages are reachable by any logged-in user, because being an
   * invitee — not a permission node — is what grants access to a given poll.
   * Redirect rather than render the no-permission page, which expects a node.
   */
  async function requireLogin(req, res) {
    if (isLoggedIn(req)) return true;
    res.redirect("/login");
    return false;
  }

  // ==========================================================================
  // List
  // ==========================================================================
  app.get("/dashboard/meetings", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.meetings, req, res, features)) return;
    if (!await requireLogin(req, res)) return;

    const canManage = userCanManage(req);
    const statusFilter = req.query.status || "";
    const search = req.query.search || "";

    const [result, globalImage, announcementWeb] = await Promise.all([
      getPolls({
        status: statusFilter || null,
        search: search || null,
        // A manager sees every poll; everyone else sees only their own.
        inviteeUserId: canManage ? null : req.session.user.userId,
        limit: 100,
      }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/meetings/meetings-list", {
        pageTitle: "Dashboard - Meetings",
        config,
        features,
        req,
        polls: result.polls,
        total: result.total,
        statusFilter,
        search,
        canManage,
        globalImage,
        announcementWeb,
      })
    );
  });

  // ==========================================================================
  // Create
  // ==========================================================================
  app.get("/dashboard/meetings/create", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.meetings, req, res, features)) return;
    if (!await hasPermission(MANAGE_NODE, req, res, features)) return;

    const [rankSlugs, globalImage, announcementWeb] = await Promise.all([
      listRankSlugs().catch((error) => {
        // A LuckPerms outage must not block the editor — the organiser can
        // still write the poll, they just cannot pick ranks until it is back.
        console.error("[dashboard/meetings] rank list failed:", error.message);
        return [];
      }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/meetings/meetings-editor", {
        pageTitle: "Dashboard - New Meeting Poll",
        config,
        features,
        req,
        mode: "create",
        poll: null,
        rankSlugs,
        apiEndpoint: "/api/meetings/create",
        globalImage,
        announcementWeb,
      })
    );
  });

  // ==========================================================================
  // Edit
  // ==========================================================================
  app.get("/dashboard/meetings/edit", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.meetings, req, res, features)) return;
    if (!await hasPermission(MANAGE_NODE, req, res, features)) return;

    const pollId = req.query.pollId;
    if (!pollId) return res.redirect("/dashboard/meetings");

    const [poll, rankSlugs, globalImage, announcementWeb] = await Promise.all([
      getPollById(pollId, req.session.user.userId),
      listRankSlugs().catch(() => []),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    if (!poll) {
      setBannerCookie("danger", "Meeting poll not found", res);
      return res.redirect("/dashboard/meetings");
    }

    if (poll.status !== "open") {
      setBannerCookie("danger", `A ${poll.status} meeting poll cannot be edited.`, res);
      return res.redirect(`/dashboard/meetings/view?pollId=${poll.pollId}`);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/meetings/meetings-editor", {
        pageTitle: "Dashboard - Edit Meeting Poll",
        config,
        features,
        req,
        mode: "edit",
        poll,
        rankSlugs,
        apiEndpoint: "/api/meetings/update",
        globalImage,
        announcementWeb,
      })
    );
  });

  // ==========================================================================
  // View + respond
  // ==========================================================================
  app.get("/dashboard/meetings/view", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.meetings, req, res, features)) return;
    if (!await requireLogin(req, res)) return;

    const pollId = req.query.pollId;
    if (!pollId) return res.redirect("/dashboard/meetings");

    const userId = req.session.user.userId;
    const canManage = userCanManage(req);

    // Authorisation is roster membership, not a permission node — check it
    // before loading the poll so a non-invitee learns nothing about it.
    if (!canManage && !(await isInvitee(pollId, userId))) {
      setBannerCookie("danger", "You are not invited to that meeting.", res);
      return res.redirect("/dashboard/meetings");
    }

    const [poll, globalImage, announcementWeb] = await Promise.all([
      getPollById(pollId, userId),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    if (!poll) {
      setBannerCookie("danger", "Meeting poll not found", res);
      return res.redirect("/dashboard/meetings");
    }

    const statusColors = { open: "success", finalized: "info", cancelled: "secondary" };

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/meetings/meetings-view", {
        pageTitle: `Dashboard - ${poll.title}`,
        config,
        features,
        req,
        poll,
        canManage,
        badgeClass: statusColors[poll.status] || "secondary",
        globalImage,
        announcementWeb,
      })
    );
  });
}
