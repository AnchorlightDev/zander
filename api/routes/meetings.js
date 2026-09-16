/**
 * Meetings API Routes
 *
 * Authenticated by the per-client API key scheme (lib/apiKeys.js, scope
 * "meetings") via the verifyToken hook.  Browser calls from the dashboard use
 * the logged-in session instead — those routes are listed in
 * SESSION_ALLOWED_ROUTES in api/routes/verifyToken.js, which holds them to the
 * same permission node as the dashboard page.  Templates never carry a token.
 *
 * Permission model: zander.web.meetings.manage gates create, edit, invite and
 * finalise.  Viewing and responding require only being an invitee on the poll.
 */

import {
  getPolls,
  getPollById,
  createPoll,
  updatePoll,
  recordResponses,
  cancelPoll,
  deletePoll,
  refreshRoster,
  isInvitee,
} from "../../services/meetingPollService.js";
import {
  expandRanksToInvitees,
  listRankSlugs,
} from "../../services/meetingRosterService.js";
import { hasPermission as checkPermNode } from "../../lib/discord/permissions.mjs";

export const MEETINGS_MANAGE_NODE = "zander.web.meetings.manage";

function actorFromReq(req) {
  const user = req.session?.user;
  return {
    actorId: user?.userId || null,
    actorName: user?.username || "System",
  };
}

/** Whether the caller may create, edit, invite or finalise. */
function isManager(req) {
  return checkPermNode(req.session?.user?.permissions || [], MEETINGS_MANAGE_NODE);
}

/**
 * Whether the caller may see a poll: managers always, invitees for their own.
 *
 * An API client key carries no session user, so it is treated as a manager —
 * it has already been scope-checked for "meetings" by verifyToken.
 */
async function canViewPoll(req, pollId) {
  if (req.apiClient) return true;
  if (isManager(req)) return true;
  return isInvitee(pollId, req.session?.user?.userId);
}

function denyManage(res) {
  return res
    .status(403)
    .send({ success: false, message: "You do not have permission to manage meetings." });
}

export default function meetingsApiRoute(app, _config, _db, features, _lang) {
  const disabled = (res) =>
    res.send({ success: false, message: "Meetings feature disabled" });

  // ==========================================================================
  // Reads
  // ==========================================================================

  /** GET /api/meetings/get — list polls, scoped to the caller unless a manager */
  app.get("/api/meetings/get", async (req, res) => {
    if (!features.meetings) return disabled(res);

    try {
      // A non-manager only ever sees polls they are on.  Scoping here rather
      // than filtering in the view keeps the roster out of the response for
      // meetings the caller has nothing to do with.
      const inviteeUserId =
        req.apiClient || isManager(req) ? null : req.session?.user?.userId || -1;

      const result = await getPolls({
        status: req.query.status || null,
        statuses: req.query.statuses ? req.query.statuses.split(",").filter(Boolean) : null,
        search: req.query.search || null,
        inviteeUserId,
        page: Math.max(parseInt(req.query.page || "1"), 1),
        limit: Math.min(parseInt(req.query.limit || "50"), 200),
      });

      return res.send({ success: true, ...result });
    } catch (err) {
      console.error("[Meetings API] get:", err);
      return res.send({ success: false, message: "Failed to fetch meetings" });
    }
  });

  /** GET /api/meetings/single?pollId=X */
  app.get("/api/meetings/single", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const pollId = req.query.pollId;
    if (!pollId) return res.send({ success: false, message: "pollId required" });

    try {
      if (!(await canViewPoll(req, pollId))) {
        return res
          .status(403)
          .send({ success: false, message: "You are not invited to this meeting." });
      }

      const poll = await getPollById(pollId, req.session?.user?.userId || null);
      if (!poll) return res.send({ success: false, message: "Meeting not found" });

      return res.send({ success: true, data: poll, canManage: isManager(req) });
    } catch (err) {
      console.error("[Meetings API] single:", err);
      return res.send({ success: false, message: "Failed to fetch meeting" });
    }
  });

  /** GET /api/meetings/roles — every LuckPerms rank, for the audience picker */
  app.get("/api/meetings/roles", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!req.apiClient && !isManager(req)) return denyManage(res);

    try {
      return res.send({ success: true, data: await listRankSlugs() });
    } catch (err) {
      console.error("[Meetings API] roles:", err);
      return res.send({ success: false, message: "Failed to fetch ranks" });
    }
  });

  /**
   * GET /api/meetings/roles/preview?rankSlugs=a,b
   *
   * Expands ranks without persisting anything, so the organiser can see who
   * they are about to invite — including the people who cannot respond and the
   * rank members with no website account at all.
   */
  app.get("/api/meetings/roles/preview", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!req.apiClient && !isManager(req)) return denyManage(res);

    const rankSlugs = (req.query.rankSlugs || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (rankSlugs.length === 0) {
      return res.send({ success: true, data: { invitees: [], unresolved: [] } });
    }

    try {
      const roster = await expandRanksToInvitees(rankSlugs);
      return res.send({
        success: true,
        data: roster,
        counts: {
          total: roster.invitees.length,
          canRespond: roster.invitees.filter((i) => i.canRespond).length,
          unresolved: roster.unresolved.length,
        },
      });
    } catch (err) {
      console.error("[Meetings API] roles/preview:", err);
      return res.send({ success: false, message: "Failed to preview roster" });
    }
  });

  /** GET /api/meetings/roster?pollId=X — the persisted roster for a poll */
  app.get("/api/meetings/roster", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const pollId = req.query.pollId;
    if (!pollId) return res.send({ success: false, message: "pollId required" });

    try {
      if (!(await canViewPoll(req, pollId))) {
        return res
          .status(403)
          .send({ success: false, message: "You are not invited to this meeting." });
      }

      const poll = await getPollById(pollId, req.session?.user?.userId || null);
      if (!poll) return res.send({ success: false, message: "Meeting not found" });

      return res.send({
        success: true,
        data: poll.invitees,
        counts: {
          total: poll.invitees.length,
          canRespond: poll.invitees.filter((i) => i.canRespond).length,
          responded: poll.respondedCount,
        },
      });
    } catch (err) {
      console.error("[Meetings API] roster:", err);
      return res.send({ success: false, message: "Failed to fetch roster" });
    }
  });

  // ==========================================================================
  // Writes
  // ==========================================================================

  /** POST /api/meetings/create */
  app.post("/api/meetings/create", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!req.apiClient && !isManager(req)) return denyManage(res);

    const body = req.body;
    if (!body?.title) return res.send({ success: false, message: "title is required" });
    if (!Array.isArray(body?.options) || body.options.length === 0) {
      return res.send({ success: false, message: "at least one time option is required" });
    }

    try {
      const { actorId } = actorFromReq(req);
      const poll = await createPoll(body, actorId);
      return res.send({ success: true, data: poll, message: "Meeting poll created" });
    } catch (err) {
      console.error("[Meetings API] create:", err);
      return res.send({ success: false, message: err.message || "Failed to create meeting" });
    }
  });

  /** POST /api/meetings/update */
  app.post("/api/meetings/update", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!req.apiClient && !isManager(req)) return denyManage(res);

    const body = req.body;
    if (!body?.pollId) return res.send({ success: false, message: "pollId is required" });

    try {
      const { actorId } = actorFromReq(req);
      const poll = await updatePoll(body.pollId, body, actorId);
      return res.send({ success: true, data: poll, message: "Meeting poll updated" });
    } catch (err) {
      console.error("[Meetings API] update:", err);
      return res.send({ success: false, message: err.message || "Failed to update meeting" });
    }
  });

  /**
   * POST /api/meetings/respond
   *
   * Body: { pollId, responses: [{ optionId, availability }] }
   *
   * Requires only being an invitee — managers have no special path here, and a
   * manager who is not on the roster cannot answer on someone else's behalf.
   * The submission must cover every option; the service rejects partial grids.
   */
  app.post("/api/meetings/respond", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const body = req.body;
    if (!body?.pollId) return res.send({ success: false, message: "pollId is required" });
    if (!Array.isArray(body?.responses)) {
      return res.send({ success: false, message: "responses array is required" });
    }

    const userId = req.session?.user?.userId;
    if (!userId) {
      return res
        .status(401)
        .send({ success: false, message: "You must be logged in to respond." });
    }

    try {
      const poll = await recordResponses(body.pollId, userId, body.responses);
      return res.send({ success: true, data: poll, message: "Availability saved" });
    } catch (err) {
      console.error("[Meetings API] respond:", err);
      return res.send({ success: false, message: err.message || "Failed to save availability" });
    }
  });

  /** POST /api/meetings/cancel */
  app.post("/api/meetings/cancel", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!req.apiClient && !isManager(req)) return denyManage(res);

    const pollId = req.body?.pollId;
    if (!pollId) return res.send({ success: false, message: "pollId is required" });

    try {
      const { actorId } = actorFromReq(req);
      const poll = await cancelPoll(pollId, actorId);
      return res.send({ success: true, data: poll, message: "Meeting poll cancelled" });
    } catch (err) {
      console.error("[Meetings API] cancel:", err);
      return res.send({ success: false, message: err.message || "Failed to cancel meeting" });
    }
  });

  /** POST /api/meetings/delete */
  app.post("/api/meetings/delete", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!req.apiClient && !isManager(req)) return denyManage(res);

    const pollId = req.body?.pollId;
    if (!pollId) return res.send({ success: false, message: "pollId is required" });

    try {
      const { actorId } = actorFromReq(req);
      await deletePoll(pollId, actorId);
      return res.send({ success: true, message: "Meeting poll deleted" });
    } catch (err) {
      console.error("[Meetings API] delete:", err);
      return res.send({ success: false, message: err.message || "Failed to delete meeting" });
    }
  });

  /**
   * POST /api/meetings/roster/refresh
   *
   * Re-expands the roster from the poll's ranks on demand.  Not the automatic
   * send-time re-resolution (that is a later pass) — this is the organiser
   * explicitly asking for the roster to be brought up to date.
   */
  app.post("/api/meetings/roster/refresh", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!req.apiClient && !isManager(req)) return denyManage(res);

    const pollId = req.body?.pollId;
    if (!pollId) return res.send({ success: false, message: "pollId is required" });

    try {
      const result = await refreshRoster(pollId);
      return res.send({ success: true, ...result, message: "Roster refreshed" });
    } catch (err) {
      console.error("[Meetings API] roster/refresh:", err);
      return res.send({ success: false, message: err.message || "Failed to refresh roster" });
    }
  });
}
