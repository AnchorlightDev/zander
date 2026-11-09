import {
  hasPermission,
  isFeatureWebRouteEnabled,
  generateLog,
} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { getWebAnnouncement, listHologramGroups } from "../../controllers/announcementController.js";
import {
  createPost,
  updatePost,
  deletePost,
  getPost,
} from "../../services/announcementPostService.js";

const PLATFORMS = ["web", "popup", "tip", "motd", "hologram"];
const COLOUR_PLATFORMS = new Set(["tip", "motd", "hologram"]);

const iso = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** A blank client wizard state. */
function emptyState(preselect) {
  const platforms = {};
  for (const p of PLATFORMS) {
    platforms[p] = { selected: preselect === p, startDate: null, endDate: null };
    if (COLOUR_PLATFORMS.has(p)) platforms[p].colourMessageFormat = "";
    else platforms[p].body = "";
    if (p !== "motd") platforms[p].link = "";
  }
  platforms.popup.popupButtonText = "";
  platforms.popup.popupImageUrl = "";
  platforms.hologram.hologramGroup = "default";
  platforms.hologram.sortOrder = 0;
  platforms.hologram.countdownTo = null;
  platforms.hologram.countdownFinishedText = "";
  return { postId: null, title: "", shared: { body: "", link: "" }, _sharedStart: null, _sharedEnd: null, _perPlatform: false, platforms };
}

/** Build client wizard state from a saved post (getPost result). */
function stateFromPost(post) {
  const state = emptyState(null);
  state.postId = post.postId;
  state.title = post.title || "";
  const windows = new Set();
  for (const row of post.platforms) {
    const p = row.announcementType;
    if (!state.platforms[p]) continue;
    const st = state.platforms[p];
    st.selected = true;
    if (COLOUR_PLATFORMS.has(p)) st.colourMessageFormat = row.colourMessageFormat || "";
    else st.body = row.body || "";
    if (p !== "motd") st.link = row.link || "";
    if (p === "popup") { st.popupButtonText = row.popupButtonText || ""; st.popupImageUrl = row.popupImageUrl || ""; }
    if (p === "hologram") {
      st.hologramGroup = row.hologramGroup || "default";
      st.sortOrder = Number.isFinite(row.sortOrder) ? row.sortOrder : 0;
      st.countdownTo = iso(row.countdownTo);
      st.countdownFinishedText = row.countdownFinishedText || "";
    }
    st.startDate = iso(row.startDate);
    st.endDate = iso(row.endDate);
    windows.add(`${st.startDate || ""}|${st.endDate || ""}`);
  }
  // If every platform shares one window, show it as the single shared schedule;
  // otherwise switch the wizard into per-platform mode so nothing is lost.
  if (windows.size <= 1) {
    const first = post.platforms[0];
    state._sharedStart = first ? iso(first.startDate) : null;
    state._sharedEnd = first ? iso(first.endDate) : null;
  } else {
    state._perPlatform = true;
  }
  return state;
}

/** Build client wizard state from a submitted payload (re-render on error). */
function stateFromPayload(payload) {
  const state = emptyState(null);
  state.postId = payload.postId || null;
  state.title = payload.title || "";
  const windows = new Set();
  for (const row of payload.platforms || []) {
    const p = row.platform;
    if (!state.platforms[p]) continue;
    const st = state.platforms[p];
    st.selected = true;
    if (COLOUR_PLATFORMS.has(p)) st.colourMessageFormat = row.colourMessageFormat || "";
    else st.body = row.body || "";
    if (p !== "motd") st.link = row.link || "";
    if (p === "popup") { st.popupButtonText = row.popupButtonText || ""; st.popupImageUrl = row.popupImageUrl || ""; }
    if (p === "hologram") {
      st.hologramGroup = row.hologramGroup || "default";
      st.sortOrder = Number.isFinite(row.sortOrder) ? row.sortOrder : 0;
      st.countdownTo = iso(row.countdownTo);
      st.countdownFinishedText = row.countdownFinishedText || "";
    }
    st.startDate = iso(row.startDate);
    st.endDate = iso(row.endDate);
    windows.add(`${st.startDate || ""}|${st.endDate || ""}`);
  }
  if (windows.size > 1) state._perPlatform = true;
  else { const f = (payload.platforms || [])[0]; state._sharedStart = f ? iso(f.startDate) : null; state._sharedEnd = f ? iso(f.endDate) : null; }
  return state;
}

export default function dashboardAnnouncementSiteRoute(app, fetch, config, db, features, lang) {
  async function renderEditor(req, res, { type, wizardState, pageTitle, notices }) {
    const [groups, announcementWeb] = await Promise.all([
      listHologramGroups().catch(() => []),
      getWebAnnouncement(),
    ]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/announcements/announcements-editor", {
        pageTitle,
        config,
        type,
        features,
        req,
        wizardState,
        hologramsEnabled: !!features.holograms,
        groups,
        announcementWeb,
        ...(notices ? { notices } : {}),
        ...adminViewData(req, features),
      })
    );
  }

  //
  // List (full rebuild lands in checkpoint 5; keep the current list working)
  //
  app.get("/dashboard/announcements", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.announcements, req, res, features)) return;
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;

    const { prisma } = await import("../../controllers/databaseController.js");
    const [announcements, announcementWeb] = await Promise.all([
      prisma.announcements.findMany({ orderBy: { announcementId: "desc" } }),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/announcements/announcements-list", {
        pageTitle: "Announcements",
        config,
        apiData: { success: true, data: announcements },
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Create (wizard)
  //
  app.get("/dashboard/announcements/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.announcements, req, res, features)) return;
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;
    const preselect = PLATFORMS.includes(req.query.platform) ? req.query.platform : null;
    return renderEditor(req, res, {
      type: "create",
      pageTitle: "Create Announcement",
      wizardState: emptyState(preselect),
    });
  });

  //
  // Edit (wizard, whole post)
  //
  app.get("/dashboard/announcements/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.announcements, req, res, features)) return;
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;

    const postId = Number(req.query.postId);
    const post = postId ? await getPost(postId) : null;
    if (!post) return res.redirect("/dashboard/announcements");

    return renderEditor(req, res, {
      type: "edit",
      pageTitle: "Edit Announcement",
      wizardState: stateFromPost(post),
    });
  });

  //
  // Save (create + edit) — calls the post service in-process.
  //
  app.post("/dashboard/announcements/save", async function (req, res) {
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;

    let payload;
    try {
      payload = JSON.parse(req.body?.payload || "{}");
    } catch {
      return res.redirect("/dashboard/announcements/create");
    }

    const createdBy = req.session?.user?.userId ?? null;
    const input = {
      title: payload.title || null,
      shared: payload.shared || {},
      platforms: payload.platforms || [],
    };

    try {
      if (payload.postId) {
        await updatePost(payload.postId, { ...input, updatedBy: createdBy });
        await generateLog(createdBy, "SUCCESS", "ANNOUNCEMENT", `Edited post ${payload.postId}`).catch(() => {});
      } else {
        const postId = await createPost({ ...input, createdBy });
        await generateLog(createdBy, "SUCCESS", "ANNOUNCEMENT", `Created post ${postId}`).catch(() => {});
      }
      res.setCookie?.("alertType", "success", { path: "/" });
      res.setCookie?.("alertContent", "Announcement saved.", { path: "/" });
      return res.redirect("/dashboard/announcements");
    } catch (error) {
      const messages = error?.errors || [String(error?.message || error)];
      console.error("[dashboard/announcements] save failed:", error?.message || error);
      return renderEditor(req, res, {
        type: payload.postId ? "edit" : "create",
        pageTitle: payload.postId ? "Edit Announcement" : "Create Announcement",
        wizardState: stateFromPayload(payload),
        notices: messages.map((m) => ({ type: "danger", message: m })),
      });
    }
  });

  //
  // Delete a whole post.
  //
  app.post("/dashboard/announcements/delete", async function (req, res) {
    if (!await hasPermission("zander.web.announcements", req, res, features)) return;
    const postId = Number(req.body?.postId);
    if (Number.isInteger(postId)) {
      try {
        await deletePost(postId);
        await generateLog(req.session?.user?.userId ?? null, "WARNING", "ANNOUNCEMENT", `Deleted post ${postId}`).catch(() => {});
      } catch (error) {
        console.error("[dashboard/announcements] delete failed:", error?.message || error);
      }
    }
    return res.redirect("/dashboard/announcements");
  });
}
