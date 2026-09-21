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
import {
  getSession,
  getSessionForViewer,
  getSessions,
  outstandingResponses,
} from "../../services/meetingSessionService.js";
import {
  isCloudinaryConfigured,
  signedAssetUrl,
} from "../../services/cloudinaryService.js";

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

    // Carry the destination through the login round trip.  A server-side
    // redirect sends no Referer, so without this an invitee following a link
    // to their meeting lands on /dashboard after signing in and has to find it
    // again.  /login sanitises returnTo (must be a single-leading-slash path).
    res.redirect(`/login?returnTo=${encodeURIComponent(req.url)}`);
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

  // ==========================================================================
  // Sessions — list
  //
  // Same direct-service approach as the poll pages above, and for the same
  // reason: a recorded session is scoped per viewer, and a self-call to the
  // JSON API would carry the internal client's identity rather than theirs.
  // ==========================================================================
  app.get("/dashboard/meetings/sessions", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.meetings, req, res, features)) return;
    if (!await requireLogin(req, res)) return;

    const canManage = userCanManage(req);
    const statusFilter = req.query.status || "";
    const search = req.query.search || "";

    const [result, globalImage, announcementWeb] = await Promise.all([
      getSessions({
        status: statusFilter || null,
        search: search || null,
        attendeeUserId: canManage ? null : req.session.user.userId,
        limit: 100,
      }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/meetings/session-list", {
        pageTitle: "Dashboard - Meeting Recordings",
        config,
        features,
        req,
        sessions: result.sessions,
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
  // Sessions — player
  // ==========================================================================
  app.get("/dashboard/meetings/session", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.meetings, req, res, features)) return;
    if (!await requireLogin(req, res)) return;

    const sessionId = req.query.sessionId;
    if (!sessionId) return res.redirect("/dashboard/meetings/sessions");

    const canManage = userCanManage(req);

    // Visibility and reveal are applied inside getSessionForViewer, in the
    // query.  Nothing below filters rows, and nothing below is handed a row it
    // is expected to hide — a note this viewer may not read has no body in the
    // object the template receives.
    const session = await getSessionForViewer(sessionId, {
      userId: req.session.user.userId,
      isManager: canManage,
    });

    if (!session) {
      setBannerCookie("danger", "Meeting session not found", res);
      return res.redirect("/dashboard/meetings/sessions");
    }
    if (session.forbidden) {
      setBannerCookie("danger", "You are not on that meeting.", res);
      return res.redirect("/dashboard/meetings/sessions");
    }

    // Signed here, after the roster check above has passed, and never stored:
    // meeting audio is uploaded `authenticated`, so the stored path is an
    // identifier and this is what actually grants access — for an hour.
    const signable = isCloudinaryConfigured();
    const recordings = session.recordings.map((recording) => ({
      recordingId: recording.recordingId,
      source: recording.source,
      startOffsetMs: recording.startOffsetMs,
      durationMs: recording.durationMs,
      mimeType: recording.mimeType,
      transcriptStatus: recording.transcriptStatus,
      url:
        signable && recording.storagePublicId
          ? signedAssetUrl(recording.storagePublicId)
          : recording.storagePath,
    }));

    const comments = session.comments.map((comment) => ({
      ...comment,
      audioUrl:
        comment.audioPublicId && signable
          ? signedAssetUrl(comment.audioPublicId)
          : comment.audioPath,
      audioPublicId: undefined,
    }));

    const [outstanding, globalImage, announcementWeb] = await Promise.all([
      // The organiser's chase list is loaded only for an organiser: a plain
      // attendee has no business knowing who else has not caught up.
      canManage || session.viewer.isChair
        ? outstandingResponses(session.sessionId).catch(() => null)
        : Promise.resolve(null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    const statusColors = {
      draft: "secondary",
      live: "danger",
      processing: "warning",
      published: "success",
      closed: "info",
      cancelled: "secondary",
    };

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/meetings/session-player", {
        pageTitle: `Dashboard - ${session.event?.title || "Meeting"}`,
        config,
        features,
        req,
        session,
        recordings,
        comments,
        outstanding,
        canManage,
        badgeClass: statusColors[session.status] || "secondary",
        globalImage,
        announcementWeb,
      })
    );
  });

  // ==========================================================================
  // Sessions — editor (agenda, roster, minutes, archive)
  // ==========================================================================
  app.get("/dashboard/meetings/session/edit", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.meetings, req, res, features)) return;
    if (!await hasPermission(MANAGE_NODE, req, res, features)) return;

    const sessionId = req.query.sessionId;
    if (!sessionId) return res.redirect("/dashboard/meetings/sessions");

    const bare = await getSession(sessionId);
    if (!bare) {
      setBannerCookie("danger", "Meeting session not found", res);
      return res.redirect("/dashboard/meetings/sessions");
    }

    // Loaded as a manager, so the editor shows unrevealed notes and the full
    // agenda — the organiser cannot schedule a reveal they cannot see.
    const [session, rankSlugs, outstanding, globalImage, announcementWeb] = await Promise.all([
      getSessionForViewer(sessionId, { userId: req.session.user.userId, isManager: true }),
      listRankSlugs().catch((error) => {
        console.error("[dashboard/meetings] rank list failed:", error.message);
        return [];
      }),
      outstandingResponses(sessionId).catch(() => null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/meetings/session-editor", {
        pageTitle: `Dashboard - Edit ${session.event?.title || "Meeting"}`,
        config,
        features,
        req,
        session,
        rankSlugs,
        outstanding,
        globalImage,
        announcementWeb,
      })
    );
  });
}
