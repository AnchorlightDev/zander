/**
 * routes/dashboard/nicknames.js
 *
 * Staff nickname tools (permission: zander.nickname.manage).
 *
 *   GET  /dashboard/nicknames                 — blocklist editor; player lookup via ?username=
 *   POST /dashboard/nicknames/reset           — reset a player's nickname (no hold, no cooldown)
 *   POST /dashboard/nicknames/lock            — lock a player out (reason, optional expiry)
 *   POST /dashboard/nicknames/unlock          — remove a lockout
 *   POST /dashboard/nicknames/release         — release a reservation or a held/hidden nickname
 *   POST /dashboard/nicknames/blocklist/add   — add a word or rank word
 *   POST /dashboard/nicknames/blocklist/remove— remove a blocklist entry
 *
 * There is no feature flag: access is the permission alone.
 */
import { getGlobalImage, hasPermission, setBannerCookie } from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  getManageView,
  listBlocklist,
  staffResetNickname,
  staffLock,
  staffUnlock,
  staffRelease,
  addBlocklistEntry,
  removeBlocklistEntry,
} from "../../controllers/nicknameController.js";

const PERMISSION_NODE = "zander.nickname.manage";

export default function dashboardNicknamesRoute(app, config, db, features, lang) {
  app.get("/dashboard/nicknames", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;

    const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
    let player = null;
    if (username) {
      try {
        player = await getManageView({ username });
      } catch (err) {
        console.error("[dashboard/nicknames] lookup failed:", err);
      }
    }

    const [blocklist, globalImage, announcementWeb] = await Promise.all([
      listBlocklist().catch(() => []),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/nicknames/nicknames", {
        pageTitle: "Nicknames",
        config,
        req,
        features,
        query: username,
        player,
        notFound: Boolean(username) && !player,
        blocklist,
        globalImage,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  const actor = (req) => req.session?.user?.userId;
  const back = (req, res) => {
    const u = req.body?.username ? `?username=${encodeURIComponent(req.body.username)}` : "";
    return res.redirect(`/dashboard/nicknames${u}`);
  };

  app.post("/dashboard/nicknames/reset", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;
    try {
      const r = await staffResetNickname({ username: req.body.username }, actor(req));
      setBannerCookie(r.ok ? "success" : "danger", r.ok ? (r.cleared ? `Reset nickname "${r.previous}".` : "That player has no nickname set.") : (r.message || "Reset failed."), res);
    } catch (err) {
      console.error("[dashboard/nicknames] reset failed:", err);
      setBannerCookie("danger", "Reset failed.", res);
    }
    return back(req, res);
  });

  app.post("/dashboard/nicknames/lock", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;
    try {
      const reason = req.body.reason ? String(req.body.reason).slice(0, 255) : null;
      const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      const r = await staffLock({ username: req.body.username }, { reason, expiresAt }, actor(req));
      setBannerCookie(r.ok ? "success" : "danger", r.ok ? "Player locked out of nicknames." : (r.message || "Lock failed."), res);
    } catch (err) {
      console.error("[dashboard/nicknames] lock failed:", err);
      setBannerCookie("danger", "Lock failed.", res);
    }
    return back(req, res);
  });

  app.post("/dashboard/nicknames/unlock", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;
    try {
      const r = await staffUnlock({ username: req.body.username }, actor(req));
      setBannerCookie(r.ok ? "success" : "danger", r.ok ? "Lockout removed." : (r.message || "Unlock failed."), res);
    } catch (err) {
      console.error("[dashboard/nicknames] unlock failed:", err);
      setBannerCookie("danger", "Unlock failed.", res);
    }
    return back(req, res);
  });

  app.post("/dashboard/nicknames/release", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;
    try {
      const reservationId = req.body.reservationId ? Number(req.body.reservationId) : null;
      const r = reservationId
        ? await staffRelease({ reservationId }, actor(req))
        : await staffRelease({ targetIdentity: { username: req.body.username } }, actor(req));
      setBannerCookie(r.ok ? "success" : "danger", r.ok ? "Nickname released." : (r.message || "Release failed."), res);
    } catch (err) {
      console.error("[dashboard/nicknames] release failed:", err);
      setBannerCookie("danger", "Release failed.", res);
    }
    return back(req, res);
  });

  app.post("/dashboard/nicknames/blocklist/add", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;
    try {
      const r = await addBlocklistEntry(req.body.entryType, req.body.value, actor(req));
      setBannerCookie(r.ok ? "success" : "danger", r.ok ? "Added to the blocklist." : (r.message || "Could not add that entry."), res);
    } catch (err) {
      console.error("[dashboard/nicknames] blocklist add failed:", err);
      setBannerCookie("danger", "Could not add that entry.", res);
    }
    return res.redirect("/dashboard/nicknames");
  });

  app.post("/dashboard/nicknames/blocklist/remove", async function (req, res) {
    if (!(await hasPermission(PERMISSION_NODE, req, res, features))) return;
    try {
      const r = await removeBlocklistEntry(Number(req.body.entryId), actor(req));
      setBannerCookie(r.ok ? "success" : "danger", r.ok ? "Removed from the blocklist." : (r.message || "Could not remove that entry."), res);
    } catch (err) {
      console.error("[dashboard/nicknames] blocklist remove failed:", err);
      setBannerCookie("danger", "Could not remove that entry.", res);
    }
    return res.redirect("/dashboard/nicknames");
  });
}
