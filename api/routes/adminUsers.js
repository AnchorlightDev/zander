/**
 * api/routes/adminUsers.js
 *
 * Staff Users dashboard API routes. Token-authed like the other /admin/*
 * route files (api/routes/badges.js) — permission gating for the sensitive
 * operations (email reveal, recovery actions) happens in the session-authed
 * dashboard layer (routes/dashboard/users.js), which is the only caller of
 * these endpoints and already checked req.session.user's permissions before
 * calling here. This layer's own responsibility is field-selection safety:
 * none of these responses ever include password_hash, reset/verification
 * codes, session tokens, or other credential material.
 *
 *   GET  /admin/users                              — paginated/filtered/searched list
 *   GET  /admin/users/stats                        — summary counts
 *   GET  /admin/users/:userId                      — detail (?revealEmail=true to include full email)
 *   POST /admin/users/:userId/reset-password       — trigger the existing password-reset flow
 *   POST /admin/users/:userId/resend-verification  — trigger the existing email-verification flow
 *   POST /admin/users/:userId/change-email         — change the login/recovery email
 */

import {
  getUsersList,
  getUsersSummaryStats,
  getUserDetailById,
  getUserEmailById,
  updateUserEmail,
} from "../../controllers/usersAdminController.js";
import {
  classifyAccountState,
  derivePlatform,
  isPasswordResetEligible,
} from "../../controllers/userAccountState.js";
import { UserGetter } from "../../controllers/userController.js";
import {
  generateVerificationCode,
  createEmailVerification,
  createPasswordResetRequest,
} from "../../controllers/sessionController.js";
import { sendMail } from "../../controllers/emailController.js";

const PASSWORD_RESET_EXPIRY_MINUTES = 10;
const EMAIL_VERIFICATION_EXPIRY_MINUTES = 10;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Defense in depth: even though usersAdminController.js never SELECTs these
// columns, strip them from any response object before it leaves this API —
// a row must never reach the browser carrying credential/token material.
const NEVER_EXPOSE_FIELDS = ["password_hash", "codeHash"];

function decorate(user) {
  const safe = { ...user };
  for (const field of NEVER_EXPOSE_FIELDS) delete safe[field];

  return {
    ...safe,
    accountState: classifyAccountState(user),
    platform: derivePlatform(user.username),
  };
}

export default function adminUsersRoute(app, config, db, features, lang) {
  // =========================================================================
  // GET /admin/users — paginated/filtered/searched list
  // =========================================================================
  app.get("/admin/users", async function (req, res) {
    try {
      const { page, limit, search, platform, accountState, emailStatus, discordStatus, disabledStatus } = req.query || {};
      const result = await getUsersList({
        page,
        limit,
        search,
        platform,
        accountState,
        emailStatus,
        discordStatus,
        disabledStatus,
      });

      return res.send({
        success: true,
        data: result.rows.map(decorate),
        total: result.total,
        page: result.page,
        limit: result.limit,
      });
    } catch (error) {
      console.error("[adminUsers] GET /admin/users:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // GET /admin/users/stats — summary counts
  // =========================================================================
  app.get("/admin/users/stats", async function (req, res) {
    try {
      const stats = await getUsersSummaryStats();
      return res.send({ success: true, data: stats });
    } catch (error) {
      console.error("[adminUsers] GET /admin/users/stats:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // GET /admin/users/:userId — detail
  // =========================================================================
  app.get("/admin/users/:userId", async function (req, res) {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    try {
      const user = await getUserDetailById(userId);
      if (!user) return res.send({ success: false, message: "User not found." });

      const data = {
        ...decorate(user),
        relatedAccounts: (user.relatedAccounts || []).map(decorate),
      };

      if (req.query?.revealEmail === "true") {
        data.email = await getUserEmailById(userId);
      } else {
        delete data.email;
      }

      return res.send({ success: true, data });
    } catch (error) {
      console.error("[adminUsers] GET /admin/users/:userId:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // POST /admin/users/:userId/reset-password — trigger existing reset flow
  // =========================================================================
  app.post("/admin/users/:userId/reset-password", async function (req, res) {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    try {
      const getter = new UserGetter();
      const user = await getter.byUserId(userId);
      if (!user) return res.send({ success: false, message: "User not found." });

      if (!isPasswordResetEligible(user)) {
        let reason = "This account does not have a configured website email and password.";
        if (user.account_disabled) {
          reason = "This account is disabled.";
        } else if (!user.email) {
          reason = "This account has no email address configured.";
        } else if (!user.password_hash) {
          reason = "This account has no website password configured.";
        }
        return res.send({
          success: false,
          message: `Password reset is unavailable because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
        });
      }

      const code = await generateVerificationCode();
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000);
      await createPasswordResetRequest(user.userId, code, expiresAt);

      await sendMail(
        user.email,
        `Reset your ${config.siteConfiguration.siteName} password`,
        "passwordResetCode.ejs",
        {
          username: user.username,
          code,
          expiryMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
          siteAddress: process.env.siteAddress,
          siteName: config.siteConfiguration.siteName,
        }
      );

      return res.send({ success: true, message: `Password reset email sent to ${user.username}.` });
    } catch (error) {
      console.error("[adminUsers] POST /admin/users/:userId/reset-password:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // POST /admin/users/:userId/resend-verification — trigger existing verify flow
  // =========================================================================
  app.post("/admin/users/:userId/resend-verification", async function (req, res) {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    try {
      const getter = new UserGetter();
      const user = await getter.byUserId(userId);
      if (!user) return res.send({ success: false, message: "User not found." });

      if (!user.email) {
        return res.send({ success: false, message: "This account has no email address to verify." });
      }

      if (user.email_verified) {
        return res.send({ success: false, message: "This account's email is already verified." });
      }

      const code = await generateVerificationCode();
      const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MINUTES * 60 * 1000);
      await createEmailVerification(user.userId, code, expiresAt);

      await sendMail(
        user.email,
        `${config.siteConfiguration.siteName} Email Verification`,
        "verificationCode.ejs",
        {
          username: user.username,
          code,
          expiryMinutes: EMAIL_VERIFICATION_EXPIRY_MINUTES,
          siteName: config.siteConfiguration.siteName,
        }
      );

      return res.send({ success: true, message: `Verification email resent to ${user.username}.` });
    } catch (error) {
      console.error("[adminUsers] POST /admin/users/:userId/resend-verification:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });

  // =========================================================================
  // POST /admin/users/:userId/change-email — staff-driven email change
  // =========================================================================
  app.post("/admin/users/:userId/change-email", async function (req, res) {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.send({ success: false, message: "Invalid userId." });

    const newEmail = (req.body?.newEmail || "").trim().toLowerCase();
    if (!newEmail || !EMAIL_FORMAT.test(newEmail)) {
      return res.send({ success: false, message: "Please provide a valid email address." });
    }

    try {
      const getter = new UserGetter();
      const user = await getter.byUserId(userId);
      if (!user) return res.send({ success: false, message: "User not found." });

      const existing = await getter.byEmail(newEmail);
      if (existing && existing.userId !== userId) {
        return res.send({ success: false, message: "That email address is already in use." });
      }

      await updateUserEmail(userId, newEmail);

      return res.send({ success: true, message: `Email updated for ${user.username}.` });
    } catch (error) {
      console.error("[adminUsers] POST /admin/users/:userId/change-email:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error}` });
    }
  });
}
