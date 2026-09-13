/**
 * routes/dashboard/users.js
 *
 * Staff "Community -> Users" dashboard: search/filter/paginate players,
 * inspect their real website account state, and perform audited account
 * recovery actions. Proxies to the /admin/users* API (api/routes/adminUsers.js)
 * the same way routes/dashboard/badges.js proxies to /admin/badges.
 *
 *   GET  /dashboard/users                              — list
 *   GET  /dashboard/users/:userId                      — detail
 *   POST /dashboard/users/:userId/reveal-email         — reveal full email (audited)
 *   POST /dashboard/users/:userId/reset-password       — trigger password reset (audited)
 *   POST /dashboard/users/:userId/resend-verification  — resend verification email (audited)
 *   POST /dashboard/users/:userId/change-email         — change login email (audited)
 *   GET  /dashboard/users/search                       — lightweight autocomplete for other screens
 */

import {
  getGlobalImage,
  hasPermission,
  generateLog,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { maskEmail, hasPermissionSilent } from "../../controllers/userAccountState.js";

const VIEW_PERMISSION = "zander.web.users";
const EMAIL_PERMISSION = "zander.web.users.email";
const MANAGE_PERMISSION = "zander.web.users.manage";

async function proxyToApi(fetch, method, path, body) {
  const res = await fetch(`${process.env.siteAddress}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-access-token": process.env.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export default function dashboardUsersRoute(app, fetch, config, db, features, lang) {
  // =========================================================================
  // GET /dashboard/users — list
  // =========================================================================
  app.get("/dashboard/users", async function (req, res) {
    if (!await hasPermission(VIEW_PERMISSION, req, res, features)) return;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = 25;
    const filters = {
      search: req.query.search || "",
      platform: req.query.platform || "",
      accountState: req.query.accountState || "",
      emailStatus: req.query.emailStatus || "",
      discordStatus: req.query.discordStatus || "",
      disabledStatus: req.query.disabledStatus || "",
    };

    const queryString = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    }).toString();

    let listData = { success: false, data: [], total: 0 };
    let statsData = { success: false, data: null };
    try {
      [listData, statsData] = await Promise.all([
        proxyToApi(fetch, "GET", `/admin/users?${queryString}`),
        proxyToApi(fetch, "GET", `/admin/users/stats`),
      ]);
    } catch (error) {
      console.error("[dashboard/users] Failed to fetch users list:", error);
    }

    const rows = (listData.data || []).map((user) => ({
      ...user,
      maskedEmail: maskEmail(user.email),
    }));

    const total = listData.total || 0;
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/users/index", {
        pageTitle: "Dashboard - Users",
        config,
        req,
        features,
        rows,
        stats: statsData.data,
        page,
        limit,
        total,
        totalPages,
        filters,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  // Lightweight autocomplete for other screens (Ranks/Badges/Support Tickets)
  // to link into the canonical user view. Registered before the parameterized
  // :userId route so Fastify prefers the static segment.
  app.get("/dashboard/users/search", async function (req, res) {
    if (!await hasPermission(VIEW_PERMISSION, req, res, features)) return;

    const q = (req.query.q || "").trim();
    if (!q || q.length < 2) return res.send({ results: [] });

    try {
      const data = await proxyToApi(fetch, "GET", `/admin/users?search=${encodeURIComponent(q)}&limit=8`);
      const results = (data.data || []).map((user) => ({
        userId: user.userId,
        username: user.username,
        accountState: user.accountState,
      }));
      return res.send({ results });
    } catch (error) {
      console.error("[dashboard/users] search error:", error);
      if (!res.sent) return res.status(500).send({ results: [] });
    }
  });

  // =========================================================================
  // GET /dashboard/users/:userId — detail
  // =========================================================================
  app.get("/dashboard/users/:userId", async function (req, res) {
    if (!await hasPermission(VIEW_PERMISSION, req, res, features)) return;

    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.redirect("/dashboard/users");

    let user = null;
    try {
      // Never request revealEmail=true on initial page load — the email
      // stays masked until the staff member explicitly clicks "Reveal".
      const data = await proxyToApi(fetch, "GET", `/admin/users/${userId}`);
      if (data.success) user = data.data;
    } catch (error) {
      console.error("[dashboard/users] Failed to fetch user detail:", error);
    }

    if (!user) {
      return res.redirect("/dashboard/users");
    }

    const sessionPermissions = req.session?.user?.permissions;
    const canRevealEmail = hasPermissionSilent(EMAIL_PERMISSION, sessionPermissions);
    const canManage = hasPermissionSilent(MANAGE_PERMISSION, sessionPermissions);

    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/users/detail", {
        pageTitle: `Dashboard - ${user.username}`,
        config,
        req,
        features,
        user: { ...user, maskedEmail: maskEmail(user.email) },
        canRevealEmail,
        canManage,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  // =========================================================================
  // POST /dashboard/users/:userId/reveal-email — audited email reveal
  // =========================================================================
  app.post("/dashboard/users/:userId/reveal-email", async function (req, res) {
    if (!await hasPermission(EMAIL_PERMISSION, req, res, features)) return;

    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    try {
      const data = await proxyToApi(fetch, "GET", `/admin/users/${userId}?revealEmail=true`);
      if (!data.success) return res.send(data);

      const actorId = req.session.user.userId;
      await generateLog(
        actorId,
        "USER_EMAIL_REVEALED",
        "users",
        `Revealed email for ${data.data.username} (#${userId})`
      );

      return res.send({ success: true, email: data.data.email });
    } catch (error) {
      console.error("[dashboard/users] reveal-email error:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Failed to reveal email." });
    }
  });

  // =========================================================================
  // POST /dashboard/users/:userId/reset-password — audited recovery action
  // =========================================================================
  app.post("/dashboard/users/:userId/reset-password", async function (req, res) {
    if (!await hasPermission(MANAGE_PERMISSION, req, res, features)) return;

    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    try {
      const data = await proxyToApi(fetch, "POST", `/admin/users/${userId}/reset-password`);
      if (data.success) {
        const actorId = req.session.user.userId;
        await generateLog(
          actorId,
          "PASSWORD_RESET_TRIGGERED",
          "users",
          `Triggered password reset for user #${userId}`
        );
      }
      return res.send(data);
    } catch (error) {
      console.error("[dashboard/users] reset-password error:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Failed to trigger password reset." });
    }
  });

  // =========================================================================
  // POST /dashboard/users/:userId/resend-verification — audited recovery action
  // =========================================================================
  app.post("/dashboard/users/:userId/resend-verification", async function (req, res) {
    if (!await hasPermission(MANAGE_PERMISSION, req, res, features)) return;

    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    try {
      const data = await proxyToApi(fetch, "POST", `/admin/users/${userId}/resend-verification`);
      if (data.success) {
        const actorId = req.session.user.userId;
        await generateLog(
          actorId,
          "VERIFICATION_RESENT",
          "users",
          `Resent email verification for user #${userId}`
        );
      }
      return res.send(data);
    } catch (error) {
      console.error("[dashboard/users] resend-verification error:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Failed to resend verification." });
    }
  });

  // =========================================================================
  // POST /dashboard/users/:userId/change-email — audited recovery action
  // =========================================================================
  app.post("/dashboard/users/:userId/change-email", async function (req, res) {
    if (!await hasPermission(MANAGE_PERMISSION, req, res, features)) return;

    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    if (req.body?.confirm !== true) {
      return res.send({ success: false, message: "Email change requires explicit confirmation." });
    }

    const newEmail = (req.body?.newEmail || "").trim();
    if (!newEmail) {
      return res.send({ success: false, message: "Please provide a new email address." });
    }

    try {
      // Fetch old (masked) email first for the audit trail.
      let oldMaskedEmail = "none";
      const before = await proxyToApi(fetch, "GET", `/admin/users/${userId}`);
      if (before.success) oldMaskedEmail = maskEmail(before.data.email) || "none";

      const data = await proxyToApi(fetch, "POST", `/admin/users/${userId}/change-email`, { newEmail });
      if (data.success) {
        const actorId = req.session.user.userId;
        await generateLog(
          actorId,
          "EMAIL_CHANGED",
          "users",
          `Changed email for user #${userId} from ${oldMaskedEmail} to ${maskEmail(newEmail)}`
        );
      }
      return res.send(data);
    } catch (error) {
      console.error("[dashboard/users] change-email error:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: "Failed to change email." });
    }
  });
}
