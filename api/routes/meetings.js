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
 * finalise.  Viewing and responding require only being an invitee on the poll,
 * or — for a recorded session — an attendee on its roster.
 *
 * The file is in two halves: phase one's availability polls (deciding *when* to
 * meet) and phase two's sessions (the meeting itself — agenda, recording,
 * comments, minutes, archive).
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
import {
  addManualAttendee,
  advanceAgenda,
  cancelSession,
  closeSession,
  confirmArchive,
  createAgendaItem,
  createComment,
  createNote,
  createSession,
  deleteAgendaItem,
  deleteComment,
  deleteNote,
  deleteSession,
  finalizePollToSession,
  getSessionForViewer,
  getSessions,
  getViewerContext,
  markResponded,
  outstandingResponses,
  publishSession,
  recordProgress,
  refreshAttendees,
  removeAttendee,
  removeSessionAudio,
  reorderAgendaItems,
  requestArchive,
  setAttendeeRole,
  updateAgendaItem,
  updateComment,
  updateNote,
  updateSession,
} from "../../services/meetingSessionService.js";
import {
  MEETINGS_FOLDER,
  isCloudinaryConfigured,
  signedAssetUrl,
  uploadAudioFile,
} from "../../services/cloudinaryService.js";
import {
  isAcceptedVoiceMimeType,
  normaliseVoiceNote,
} from "../../lib/meetings/audioTranscode.mjs";
import { hasPermission as checkPermNode } from "../../lib/discord/permissions.mjs";
import { createWriteStream } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";

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
      // -1 rather than null for a caller with no session: null would lift the
      // invitee filter entirely and list every poll, so an unauthenticated or
      // session-less caller must match a userId that cannot exist.
      const inviteeUserId =
        req.apiClient || isManager(req) ? null : (req.session?.user?.userId ?? -1);

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

  // ==========================================================================
  // Sessions (phase two)
  //
  // Same guard and permission model as the poll routes above: organiser actions
  // need zander.web.meetings.manage, while viewing and commenting need only
  // roster membership — which the handlers check themselves, because being an
  // attendee is not a permission node.
  //
  // Visibility and reveal are applied by the service, in the query.  Nothing
  // below hands a template a row it is expected to hide.
  // ==========================================================================

  /** Is the caller allowed to manage this module at all? */
  const manages = (req) => Boolean(req.apiClient) || isManager(req);

  function requireLogin(req, res) {
    const userId = req.session?.user?.userId;
    if (!userId) {
      res.status(401).send({ success: false, message: "You must be logged in." });
      return null;
    }
    return userId;
  }

  /**
   * Load a session for the caller, or send the right refusal.
   *
   * Returns null once a response has been sent, so every handler reads as
   * `const session = await loadForViewer(...); if (!session) return;`.
   */
  async function loadForViewer(req, res, sessionId, options = {}) {
    if (!sessionId) {
      res.send({ success: false, message: "sessionId required" });
      return null;
    }

    const session = await getSessionForViewer(sessionId, {
      userId: req.session?.user?.userId || null,
      isManager: manages(req),
      ...options,
    });

    if (!session) {
      res.send({ success: false, message: "Meeting session not found" });
      return null;
    }
    if (session.forbidden) {
      res.status(403).send({ success: false, message: "You are not on this meeting." });
      return null;
    }

    return session;
  }

  /**
   * Swap stored public_ids for short-lived signed URLs.
   *
   * Meeting audio is uploaded `authenticated`, so the stored `storagePath` is an
   * identifier rather than a usable link.  The signature is minted here, per
   * request, *after* the roster check above has passed — never baked into a
   * page and never stored.
   */
  function withSignedAudio(session) {
    const signable = isCloudinaryConfigured();

    const recordings = session.recordings.map((recording) => ({
      ...recording,
      storagePath:
        signable && recording.storagePublicId
          ? signedAssetUrl(recording.storagePublicId)
          : recording.storagePath,
      // The id itself is of no use to a browser and is not sent out.
      storagePublicId: undefined,
    }));

    const comments = session.comments.map((comment) =>
      comment.audioPublicId
        ? {
            ...comment,
            audioPath: signable ? signedAssetUrl(comment.audioPublicId) : comment.audioPath,
            audioPublicId: undefined,
          }
        : comment
    );

    return { ...session, recordings, comments };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** GET /api/meetings/sessions — list, scoped to the caller unless a manager */
  app.get("/api/meetings/sessions", async (req, res) => {
    if (!features.meetings) return disabled(res);

    try {
      // -1 rather than null for a session-less caller: null would lift the
      // attendee filter and list every meeting.
      const attendeeUserId = manages(req) ? null : (req.session?.user?.userId ?? -1);

      const result = await getSessions({
        status: req.query.status || null,
        statuses: req.query.statuses ? req.query.statuses.split(",").filter(Boolean) : null,
        search: req.query.search || null,
        attendeeUserId,
        page: Math.max(parseInt(req.query.page || "1"), 1),
        limit: Math.min(parseInt(req.query.limit || "50"), 200),
      });

      return res.send({ success: true, ...result });
    } catch (err) {
      console.error("[Meetings API] sessions:", err);
      return res.send({ success: false, message: "Failed to fetch meeting sessions" });
    }
  });

  /**
   * GET /api/meetings/session?sessionId=X&playbackOffsetMs=N
   *
   * `playbackOffsetMs` is the client saying where it has played to.  It is a
   * request, not proof, so it only ever affects `on_playback` reveal — which is
   * documented at every layer as a reading-ahead deterrent and nothing more.
   */
  app.get("/api/meetings/session", async (req, res) => {
    if (!features.meetings) return disabled(res);

    try {
      const session = await loadForViewer(req, res, req.query.sessionId, {
        playbackOffsetMs: req.query.playbackOffsetMs ?? null,
      });
      if (!session) return;

      return res.send({
        success: true,
        data: withSignedAudio(session),
        canManage: manages(req),
      });
    } catch (err) {
      console.error("[Meetings API] session:", err);
      return res.send({ success: false, message: "Failed to fetch meeting session" });
    }
  });

  /** GET /api/meetings/session/outstanding?sessionId=X — organiser chase list */
  app.get("/api/meetings/session/outstanding", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      return res.send({ success: true, data: await outstandingResponses(req.query.sessionId) });
    } catch (err) {
      console.error("[Meetings API] outstanding:", err);
      return res.send({ success: false, message: "Failed to fetch outstanding responses" });
    }
  });

  // ── Session lifecycle ────────────────────────────────────────────────────

  /** POST /api/meetings/session/create — body: { eventId, agendaItems?, rankSlugs? } */
  app.post("/api/meetings/session/create", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const { actorId } = actorFromReq(req);
      const session = await createSession(req.body || {}, actorId);
      return res.send({ success: true, data: session, message: "Meeting session created" });
    } catch (err) {
      console.error("[Meetings API] session/create:", err);
      return res.send({ success: false, message: err.message || "Failed to create session" });
    }
  });

  /** POST /api/meetings/session/update */
  app.post("/api/meetings/session/update", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.send({ success: false, message: "sessionId is required" });

    try {
      const { actorId } = actorFromReq(req);
      const session = await updateSession(sessionId, req.body, actorId);
      return res.send({ success: true, data: session, message: "Meeting session updated" });
    } catch (err) {
      console.error("[Meetings API] session/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update session" });
    }
  });

  /** POST /api/meetings/session/publish | /close | /cancel */
  for (const [path, handler, message] of [
    ["publish", (id, body) => publishSession(id, { responseDeadlineAt: body?.responseDeadlineAt }), "Meeting published"],
    ["close", (id) => closeSession(id), "Meeting closed"],
    ["cancel", (id) => cancelSession(id), "Meeting cancelled"],
  ]) {
    app.post(`/api/meetings/session/${path}`, async (req, res) => {
      if (!features.meetings) return disabled(res);
      if (!manages(req)) return denyManage(res);

      const sessionId = req.body?.sessionId;
      if (!sessionId) return res.send({ success: false, message: "sessionId is required" });

      try {
        const data = await handler(sessionId, req.body);
        return res.send({ success: true, data, message });
      } catch (err) {
        console.error(`[Meetings API] session/${path}:`, err);
        return res.send({ success: false, message: err.message || "Failed" });
      }
    });
  }

  /** POST /api/meetings/session/delete — removes stored assets first */
  app.post("/api/meetings/session/delete", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.send({ success: false, message: "sessionId is required" });

    try {
      await deleteSession(sessionId);
      return res.send({ success: true, message: "Meeting session deleted" });
    } catch (err) {
      console.error("[Meetings API] session/delete:", err);
      return res.send({ success: false, message: err.message || "Failed to delete session" });
    }
  });

  /**
   * POST /api/meetings/finalize — body: { pollId, optionId }
   *
   * The finalise -> event handoff phase one parked: writes the `events` row with
   * `internal = true` and `meetingPollId` back-linked, then creates its session.
   */
  app.post("/api/meetings/finalize", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    const pollId = req.body?.pollId;
    if (!pollId) return res.send({ success: false, message: "pollId is required" });

    try {
      const { actorId } = actorFromReq(req);
      const result = await finalizePollToSession(pollId, req.body?.optionId, actorId, req.body || {});
      return res.send({
        success: true,
        data: result,
        message: result.created ? "Meeting scheduled" : "This poll already has a meeting",
      });
    } catch (err) {
      console.error("[Meetings API] finalize:", err);
      return res.send({ success: false, message: err.message || "Failed to finalise meeting" });
    }
  });

  // ── Agenda ───────────────────────────────────────────────────────────────

  app.post("/api/meetings/agenda/create", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const item = await createAgendaItem(req.body?.sessionId, req.body);
      return res.send({ success: true, data: item, message: "Agenda item added" });
    } catch (err) {
      console.error("[Meetings API] agenda/create:", err);
      return res.send({ success: false, message: err.message || "Failed to add agenda item" });
    }
  });

  app.post("/api/meetings/agenda/update", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const item = await updateAgendaItem(req.body?.itemId, req.body);
      return res.send({ success: true, data: item, message: "Agenda item updated" });
    } catch (err) {
      console.error("[Meetings API] agenda/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update agenda item" });
    }
  });

  app.post("/api/meetings/agenda/delete", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      await deleteAgendaItem(req.body?.itemId);
      // Its comments and notes survive — the FKs are SET NULL — so this is not
      // as destructive as deleting an item sounds.
      return res.send({ success: true, message: "Agenda item deleted" });
    } catch (err) {
      console.error("[Meetings API] agenda/delete:", err);
      return res.send({ success: false, message: err.message || "Failed to delete agenda item" });
    }
  });

  app.post("/api/meetings/agenda/reorder", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const items = await reorderAgendaItems(req.body?.sessionId, req.body?.itemIds || []);
      return res.send({ success: true, data: items, message: "Agenda reordered" });
    } catch (err) {
      console.error("[Meetings API] agenda/reorder:", err);
      return res.send({ success: false, message: err.message || "Failed to reorder agenda" });
    }
  });

  /**
   * POST /api/meetings/agenda/advance
   *
   * The same service call `/meeting next` makes in Discord — the chapter stamps
   * have to be identical whichever surface the chair uses.
   */
  app.post("/api/meetings/agenda/advance", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const { actorId } = actorFromReq(req);
      const result = await advanceAgenda({ sessionId: req.body?.sessionId, actorId });
      return res.send({ success: true, data: result, message: "Agenda advanced" });
    } catch (err) {
      console.error("[Meetings API] agenda/advance:", err);
      return res.send({ success: false, message: err.message || "Failed to advance agenda" });
    }
  });

  // ── Notes ────────────────────────────────────────────────────────────────

  app.post("/api/meetings/notes/create", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      // Minute-taking is for chairs and speakers, checked against the roster
      // role rather than a permission node — the person minuting is often not
      // the person administering the module.
      const viewer = await getViewerContext(req.body?.sessionId, { userId, isManager: isManager(req) });
      if (!viewer.isSpeaker) {
        return res.status(403).send({ success: false, message: "Only chairs and speakers can take minutes." });
      }

      const note = await createNote(req.body?.sessionId, req.body, userId);
      return res.send({ success: true, data: note, message: "Note saved" });
    } catch (err) {
      console.error("[Meetings API] notes/create:", err);
      return res.send({ success: false, message: err.message || "Failed to save note" });
    }
  });

  app.post("/api/meetings/notes/update", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      const note = await updateNote(req.body?.noteId, req.body, userId, { isManager: isManager(req) });
      return res.send({ success: true, data: note, message: "Note updated" });
    } catch (err) {
      console.error("[Meetings API] notes/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update note" });
    }
  });

  app.post("/api/meetings/notes/delete", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      await deleteNote(req.body?.noteId, userId, { isManager: isManager(req) });
      return res.send({ success: true, message: "Note deleted" });
    } catch (err) {
      console.error("[Meetings API] notes/delete:", err);
      return res.send({ success: false, message: err.message || "Failed to delete note" });
    }
  });

  // ── Comments ─────────────────────────────────────────────────────────────

  /**
   * POST /api/meetings/comments/create
   *
   * Requires roster membership, not a permission node — the whole point of the
   * module is that someone with no dashboard permissions at all can still catch
   * up on a meeting they were invited to and say something about it.
   */
  app.post("/api/meetings/comments/create", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      const session = await loadForViewer(req, res, req.body?.sessionId);
      if (!session) return;

      const comment = await createComment(session.sessionId, req.body, userId);
      return res.send({ success: true, data: comment, message: "Comment posted" });
    } catch (err) {
      console.error("[Meetings API] comments/create:", err);
      return res.send({ success: false, message: err.message || "Failed to post comment" });
    }
  });

  app.post("/api/meetings/comments/update", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      const comment = await updateComment(req.body?.commentId, req.body, userId, {
        isManager: isManager(req),
      });
      return res.send({ success: true, data: comment, message: "Comment updated" });
    } catch (err) {
      console.error("[Meetings API] comments/update:", err);
      return res.send({ success: false, message: err.message || "Failed to update comment" });
    }
  });

  app.post("/api/meetings/comments/delete", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      await deleteComment(req.body?.commentId, userId, { isManager: isManager(req) });
      return res.send({ success: true, message: "Comment deleted" });
    } catch (err) {
      console.error("[Meetings API] comments/delete:", err);
      return res.send({ success: false, message: err.message || "Failed to delete comment" });
    }
  });

  /**
   * POST /api/meetings/comments/voice — multipart voice note.
   *
   * Accepts webm/opus and mp4/aac and normalises server-side: Chrome and
   * Firefox produce the first, iOS Safari the second, and a good share of the
   * roster will be commenting from a phone.
   *
   * Streamed to a scratch file rather than buffered — same rule as the meeting
   * recording itself — then transcoded and uploaded, and the scratch file is
   * removed in a finally block so a failed upload does not leave the disk
   * filling up with abandoned notes.
   */
  app.post("/api/meetings/comments/voice", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    const MAX_BYTES = 25 * 1024 * 1024;

    let upload;
    try {
      upload = await req.file();
    } catch {
      return res.status(400).send({ success: false, message: "No audio provided." });
    }
    if (!upload?.file) {
      return res.status(400).send({ success: false, message: "No audio provided." });
    }

    if (!isAcceptedVoiceMimeType(upload.mimetype)) {
      return res.status(415).send({
        success: false,
        message: `Unsupported audio format "${upload.mimetype}". Record in your browser and try again.`,
      });
    }

    const sessionId = upload.fields?.sessionId?.value;
    const session = await loadForViewer(req, res, sessionId);
    if (!session) return;

    const scratchDir = await mkdtemp(join(tmpdir(), "zander-voicenote-"));
    const rawPath = join(scratchDir, "upload.bin");
    const normalisedPath = join(scratchDir, "note.ogg");

    try {
      let bytes = 0;
      upload.file.on("data", (chunk) => {
        bytes += chunk.length;
      });

      await pipeline(upload.file, createWriteStream(rawPath));

      if (upload.file.truncated || bytes > MAX_BYTES) {
        return res.status(413).send({ success: false, message: "Voice note too large. Maximum 25 MB." });
      }

      const { durationMs } = await normaliseVoiceNote(rawPath, normalisedPath);

      let audioPath = normalisedPath;
      let audioPublicId = null;

      if (isCloudinaryConfigured()) {
        const uploaded = await uploadAudioFile(normalisedPath, { folder: MEETINGS_FOLDER });
        audioPath = uploaded.url;
        audioPublicId = uploaded.publicId;
      }

      const comment = await createComment(
        session.sessionId,
        {
          kind: "voice",
          body: upload.fields?.body?.value || null,
          atOffsetMs: upload.fields?.atOffsetMs?.value ?? null,
          agendaItemId: upload.fields?.agendaItemId?.value ?? null,
          parentCommentId: upload.fields?.parentCommentId?.value ?? null,
          visibility: upload.fields?.visibility?.value || undefined,
          audioPath,
          audioPublicId,
          audioDurationMs: durationMs,
        },
        userId
      );

      return res.send({ success: true, data: comment, message: "Voice note posted" });
    } catch (err) {
      console.error("[Meetings API] comments/voice:", err);
      return res.status(500).send({ success: false, message: err.message || "Failed to post voice note" });
    } finally {
      // Only the scratch copies: once Cloudinary holds it, the URL is already
      // on the comment row.  Where Cloudinary is unconfigured the normalised
      // file is the stored asset, so it is kept.
      await rm(rawPath, { force: true }).catch(() => {});
      if (isCloudinaryConfigured()) {
        await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  // ── Progress ─────────────────────────────────────────────────────────────

  /**
   * POST /api/meetings/progress — body: { sessionId, lastOffsetMs, completed?, responded? }
   *
   * Roster membership only.  The reported position is trusted for the viewer's
   * own bookmark and for nothing else: `on_playback` reveal reads it, and that
   * is why on_playback is documented as a deterrent rather than a control.
   */
  app.post("/api/meetings/progress", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      const session = await loadForViewer(req, res, req.body?.sessionId);
      if (!session) return;

      const progress = await recordProgress({
        sessionId: session.sessionId,
        userId,
        lastOffsetMs: req.body?.lastOffsetMs,
        completed: Boolean(req.body?.completed),
        responded: Boolean(req.body?.responded),
      });

      return res.send({
        success: true,
        data: {
          lastOffsetMs: Number(progress.lastOffsetMs),
          completedAt: progress.completedAt,
          respondedAt: progress.respondedAt,
        },
      });
    } catch (err) {
      console.error("[Meetings API] progress:", err);
      return res.send({ success: false, message: err.message || "Failed to save progress" });
    }
  });

  /** POST /api/meetings/progress/responded — the explicit "I'm caught up" */
  app.post("/api/meetings/progress/responded", async (req, res) => {
    if (!features.meetings) return disabled(res);

    const userId = requireLogin(req, res);
    if (!userId) return;

    try {
      const session = await loadForViewer(req, res, req.body?.sessionId);
      if (!session) return;

      await markResponded(session.sessionId, userId);
      return res.send({ success: true, message: "Marked as caught up" });
    } catch (err) {
      console.error("[Meetings API] progress/responded:", err);
      return res.send({ success: false, message: err.message || "Failed to update" });
    }
  });

  // ── Attendees ────────────────────────────────────────────────────────────

  app.post("/api/meetings/attendees/refresh", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const result = await refreshAttendees(req.body?.sessionId, {
        rankSlugs: req.body?.rankSlugs || null,
      });
      return res.send({ success: true, ...result, message: "Attendees refreshed" });
    } catch (err) {
      console.error("[Meetings API] attendees/refresh:", err);
      return res.send({ success: false, message: err.message || "Failed to refresh attendees" });
    }
  });

  app.post("/api/meetings/attendees/add", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const attendee = await addManualAttendee(req.body?.sessionId, req.body?.userId, req.body?.role);
      return res.send({ success: true, data: attendee, message: "Attendee added" });
    } catch (err) {
      console.error("[Meetings API] attendees/add:", err);
      return res.send({ success: false, message: err.message || "Failed to add attendee" });
    }
  });

  app.post("/api/meetings/attendees/remove", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      await removeAttendee(req.body?.sessionId, req.body?.userId);
      return res.send({ success: true, message: "Attendee removed" });
    } catch (err) {
      console.error("[Meetings API] attendees/remove:", err);
      return res.send({ success: false, message: err.message || "Failed to remove attendee" });
    }
  });

  /**
   * POST /api/meetings/attendees/role
   *
   * The only way a role is ever set.  Nothing infers one from who spoke: a
   * quiet presenter keeps speaker access to the minutes, and a chatty observer
   * does not gain it.
   */
  app.post("/api/meetings/attendees/role", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const attendee = await setAttendeeRole(req.body?.sessionId, req.body?.userId, req.body?.role);
      return res.send({ success: true, data: attendee, message: "Role updated" });
    } catch (err) {
      console.error("[Meetings API] attendees/role:", err);
      return res.send({ success: false, message: err.message || "Failed to update role" });
    }
  });

  // ── Archive ──────────────────────────────────────────────────────────────

  /** POST /api/meetings/archive/request — queues the build; the cron does it */
  app.post("/api/meetings/archive/request", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const session = await requestArchive(req.body?.sessionId);
      return res.send({ success: true, data: session, message: "Archive queued" });
    } catch (err) {
      console.error("[Meetings API] archive/request:", err);
      return res.send({ success: false, message: err.message || "Failed to queue archive" });
    }
  });

  /**
   * POST /api/meetings/archive/confirm
   *
   * A person stating they have opened the bundle and it is intact.  This, and
   * only this, unlocks deleting the hosted audio — the builder cannot confirm
   * its own work, because "it downloaded, so it's safe" is how meetings get
   * lost.
   */
  app.post("/api/meetings/archive/confirm", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const { actorId } = actorFromReq(req);
      const session = await confirmArchive(req.body?.sessionId, actorId);
      return res.send({ success: true, data: session, message: "Archive confirmed" });
    } catch (err) {
      console.error("[Meetings API] archive/confirm:", err);
      return res.send({ success: false, message: err.message || "Failed to confirm archive" });
    }
  });

  /** POST /api/meetings/audio/remove — blocked until the archive is confirmed */
  app.post("/api/meetings/audio/remove", async (req, res) => {
    if (!features.meetings) return disabled(res);
    if (!manages(req)) return denyManage(res);

    try {
      const result = await removeSessionAudio(req.body?.sessionId);
      return res.send({ success: true, ...result, message: "Hosted audio removed" });
    } catch (err) {
      console.error("[Meetings API] audio/remove:", err);
      return res.send({ success: false, message: err.message || "Failed to remove audio" });
    }
  });
}
