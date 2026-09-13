import dotenv from "dotenv";
dotenv.config();
import qs from "querystring";
import bcrypt from "bcrypt";
import {
  isFeatureWebRouteEnabled,
  setBannerCookie,
  getGlobalImage,
  internalApiHeaders,
} from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import {
  UserGetter,
  getProfilePicture,
  getUserPermissions,
  createLocalUser,
  updateLocalUserCredentials,
  updateUserPassword,
  markEmailVerified,
  markAccountRegistered,
  mergePlaceholderUser,
  clearPlaceholderFlag,
  UserLinkGetter,
} from "../controllers/userController.js";
import { updateAudit_lastWebsiteLogin } from "../controllers/auditController.js";
import {
  createEmailVerification,
  generateVerificationCode,
  verifyEmailCode,
  createPasswordResetRequest,
  verifyPasswordResetCode,
} from "../controllers/sessionController.js";
import { sendMail } from "../controllers/emailController.js";
import { checkRateLimit } from "../lib/rateLimiter.mjs";

export default function sessionSiteRoute(
  app,
  client,
  fetch,
  moment,
  config,
  db,
  features,
  lang
) {
  //
  // Session
  //
  const emailVerificationExpiryMinutes = 10;
  const passwordResetExpiryMinutes = 10;
  const passwordRequirements = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{8,}$/;

  const buildDiscordAuthorizeUrl = () => {
    const params = {
      client_id: process.env.discordClientId,
      redirect_uri: `${process.env.siteAddress}/login/callback`,
      response_type: "code",
      scope: "identify",
    };

    return `https://discord.com/api/oauth2/authorize?${qs.stringify(params)}`;
  };

  const normaliseEmail = (email) => (email || "").trim().toLowerCase();

  const formatMojangUuid = (rawUuid) => {
    if (!rawUuid) return null;

    const cleaned = rawUuid.replace(/-/g, "");
    if (cleaned.length !== 32) {
      return null;
    }

    return `${cleaned.substring(0, 8)}-${cleaned.substring(8, 12)}-${cleaned.substring(
      12,
      16
    )}-${cleaned.substring(16, 20)}-${cleaned.substring(20)}`;
  };

  const logRouteError = (context, error) => {
    const message =
      error && typeof error === "object" && "message" in error
        ? error.message
        : String(error ?? "Unknown error");

    const details = [];
    if (error && typeof error === "object") {
      if ("code" in error && error.code) {
        details.push(`code=${error.code}`);
      }
      if ("status" in error && error.status) {
        details.push(`status=${error.status}`);
      }
      if ("responseCode" in error && error.responseCode) {
        details.push(`responseCode=${error.responseCode}`);
      }
    }

    const suffix = details.length ? ` (${details.join(", ")})` : "";
    console.error(`[SESSION] ${context}: ${message}${suffix}`);
  };

  async function hydrateUserSession(req, userLoginData) {
    // Issue a fresh session id at the moment privilege is granted.
    //
    // Without this the id the visitor arrived with survives login, so anyone
    // who managed to fix a known session id on the victim's browser
    // beforehand would hold an authenticated session afterwards. Every login
    // path (local, Discord OAuth, verification link) funnels through here, so
    // regenerating once covers all four callers.
    //
    // returnTo is preserved: it is set before login to remember where the
    // visitor was headed, and dropping it would send them to the dashboard
    // instead of back to the page they wanted.
    try {
      await req.session.regenerate(["returnTo"]);
    } catch (error) {
      logRouteError("session regenerate on login", error);
    }

    const userPermissionData = await getUserPermissions(userLoginData);
    // userPermissionData.userRanks is an array of rank slug strings e.g. ["admin","member"]
    const rankSlugs = userPermissionData.userRanks || [];

    // Store ranks as objects so callers can do rank.rankSlug (used across support, appeal, profile routes)
    const userRanks = rankSlugs.map((slug) => ({ rankSlug: slug }));

    // Derive isStaff from whether the user's resolved permissions include meta.staff.1 (set on staff groups in LuckPerms)
    const isStaff = userPermissionData.some(
      (p) => p && String(p).trim().toLowerCase().startsWith("meta.staff.")
    );

    req.session.authenticated = true;
    req.session.user = {
      userId: userLoginData.userId,
      username: userLoginData.username,
      profilePicture: await getProfilePicture(userLoginData.username),
      discordID: userLoginData.discordId,
      uuid: userLoginData.uuid,
      ranks: userRanks,
      permissions: userPermissionData,
      permissionsRefreshedAt: Date.now(),
      isStaff,
    };

    await updateAudit_lastWebsiteLogin(new Date(), userLoginData.username);
  }

  app.get("/login", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 30 })) return;

    if (req.query.returnTo && typeof req.query.returnTo === "string") {
      const sanitizedReturnTo =
        req.query.returnTo.startsWith("/") &&
        !req.query.returnTo.startsWith("//")
          ? req.query.returnTo
          : null;
      if (sanitizedReturnTo) {
        req.session.returnTo = sanitizedReturnTo;
      }
    }

    if (!req.session.returnTo && req.headers.referer) {
      try {
        const refererUrl = new URL(req.headers.referer);
        const siteAddress = process.env.siteAddress;
        const isSameHost =
          (siteAddress && req.headers.referer.startsWith(siteAddress)) ||
          (req.headers.host && refererUrl.host === req.headers.host);
        if (isSameHost) {
          const refererPath = `${refererUrl.pathname}${refererUrl.search}`;
          if (!refererPath.startsWith("/login") && !refererPath.startsWith("/logout")) {
            req.session.returnTo = refererPath;
          }
        }
      } catch (error) {
        // Ignore invalid referer values.
      }
    }

    if (req.session.user) {
      const returnTo =
        typeof req.session.returnTo === "string" &&
        req.session.returnTo.startsWith("/") &&
        !req.session.returnTo.startsWith("//")
          ? req.session.returnTo
          : null;
      if (returnTo) {
        delete req.session.returnTo;
        return res.redirect(returnTo);
      }
      return res.redirect("/dashboard");
    }

    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    const discordAuthorizeUrl = buildDiscordAuthorizeUrl();

    if (req.query.provider === "discord") {
      return res.redirect(discordAuthorizeUrl);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/login", {
      pageTitle: `Login`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      discordAuthorizeUrl,
    }));
    return;
  });

  app.post("/login", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, max: 10 })) return;

    if (req.session.user) {
      return res.redirect("/dashboard");
    }

    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    const identifier = req.body.identifier ? req.body.identifier.trim() : "";
    const password = req.body.password || "";

    if (!identifier || !password) {
      setBannerCookie("warning", "Username/email and password are required.", res);
      return res.redirect(`/login`);
    }

    try {
      const userGetter = new UserGetter();
      const user = await userGetter.byUsernameOrEmail(identifier);

      if (!user || !user.password_hash) {
        setBannerCookie("danger", "Invalid credentials.", res);
        return res.redirect(`/login`);
      }

      if (user.account_disabled) {
        setBannerCookie(
          "danger",
          "Your account is disabled. Please contact the team for assistance.",
          res
        );
        return res.redirect(`/login`);
      }

      const passwordMatch = await bcrypt.compare(password, user.password_hash);

      if (!passwordMatch) {
        setBannerCookie("danger", "Invalid credentials.", res);
        return res.redirect(`/login`);
      }

      if (!user.email_verified) {
        req.session.pendingRegistration = {
          userId: user.userId,
          username: user.username,
          email: user.email,
          stage: "EMAIL",
        };
        setBannerCookie("warning", "Please verify your email to continue.", res);
        return res.redirect(`/register/verify-email`);
      }

      if (!user.account_registered) {
        req.session.pendingRegistration = {
          userId: user.userId,
          username: user.username,
          email: user.email,
          stage: "MINECRAFT",
        };
        setBannerCookie(
          "warning",
          "Please finish verifying your Minecraft account to continue.",
          res
        );
        return res.redirect(`/register/minecraft`);
      }

      await hydrateUserSession(req, user);
      delete req.session.passwordReset;

      // Extend session to 30 days if "Remember Me" is checked
      if (req.body.rememberMe) {
        req.session.cookie.maxAge = 86400000 * 30; // 30 days
      }

      setBannerCookie("success", "Logged in successfully.", res);
      const returnTo =
        typeof req.session.returnTo === "string" &&
        req.session.returnTo.startsWith("/")
          ? req.session.returnTo
          : null;
      if (returnTo) {
        delete req.session.returnTo;
        return res.redirect(returnTo);
      }
      return res.redirect(`${process.env.siteAddress}/`);
    } catch (error) {
      logRouteError("local login attempt", error);
      setBannerCookie("danger", "Unable to log in, please try again soon.", res);
      return res.redirect(`/login`);
    }
  });

  app.get("/login/discord", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 20 })) return;

    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    if (req.query.returnTo && typeof req.query.returnTo === "string") {
      const sanitizedReturnTo =
        req.query.returnTo.startsWith("/") && !req.query.returnTo.startsWith("//")
          ? req.query.returnTo
          : null;
      if (sanitizedReturnTo) {
        req.session.returnTo = sanitizedReturnTo;
      }
    }

    return res.redirect(buildDiscordAuthorizeUrl());
  });

  app.get("/login/callback", async (req, res) => {
    const { code, error: oauthError } = req.query;

    // Discord sends us back with ?error=access_denied (and no code) when the
    // user declines the consent screen. That is a normal outcome, not a
    // failure — don't log it as one.
    if (oauthError) {
      setBannerCookie("info", "Discord sign-in was cancelled.", res);
      return res.redirect("/login");
    }

    // No code and no error means the callback was hit directly — a bot
    // probing the URL, or a stale bookmark. Nothing to report.
    if (!code) {
      return res.redirect("/login");
    }

    try {
      const tokenParams = {
        client_id: process.env.discordClientId,
        client_secret: process.env.discordClientSecret,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: `${process.env.siteAddress}/login/callback`,
        scope: "identify",
      };

      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: qs.stringify(tokenParams),
      });

      if (!tokenResponse.ok) {
        const errorText = `Failed to obtain access token: ${tokenResponse.status} ${tokenResponse.statusText}`;
        logRouteError("discord token exchange", errorText);
        throw new Error(errorText);
      }

      const tokenData = await tokenResponse.json();
      const userResponse = await fetch("https://discord.com/api/users/@me", {
        headers: {
          Authorization: `${tokenData.token_type} ${tokenData.access_token}`,
        },
      });

      if (!userResponse.ok) {
        const errorText = `Failed to fetch user data: ${userResponse.status} ${userResponse.statusText}`;
        logRouteError("discord user fetch", errorText);
        throw new Error(errorText);
      }

      const userData = await userResponse.json();
      const userGetData = new UserGetter();
      const userIsRegistered = await userGetData.isRegistered(userData.id);

      if (!userIsRegistered) {
        res.cookie("discordId", userData.id, {
          path: "/",
          httpOnly: true,
          maxAge: 10 * 60 * 1000,
        });

        return res.redirect(`/unregistered`);
      }

      const userLoginData = await userGetData.byDiscordId(userData.id);
      await hydrateUserSession(req, userLoginData);
      delete req.session.passwordReset;

      const returnTo =
        typeof req.session.returnTo === "string" &&
        req.session.returnTo.startsWith("/")
          ? req.session.returnTo
          : null;
      if (returnTo) {
        delete req.session.returnTo;
        return res.redirect(returnTo);
      }
      return res.redirect(`${process.env.siteAddress}/`);
    } catch (error) {
      logRouteError("discord OAuth callback", error);
      setBannerCookie("danger", "Discord authentication failed.", res);
      return res.redirect(`/login`);
    }
  });

  app.get("/forgot-password", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    if (req.session.user) {
      return res.redirect(`/`);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/forgotPassword", {
      pageTitle: `Forgot Password`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.post("/forgot-password", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    if (req.session.user) {
      return res.redirect(`/`);
    }

    const identifier = req.body.identifier ? req.body.identifier.trim() : "";

    if (!identifier) {
      setBannerCookie(
        "warning",
        "Please provide a username or email address.",
        res
      );
      return res.redirect(`/forgot-password`);
    }

    try {
      const userGetter = new UserGetter();
      const user = await userGetter.byUsernameOrEmail(identifier);

      if (user && user.email && user.password_hash) {
        const code = await generateVerificationCode();
        const expiresAt = new Date(
          Date.now() + passwordResetExpiryMinutes * 60 * 1000
        );

        await createPasswordResetRequest(user.userId, code, expiresAt);

        await sendMail(
          user.email,
          `Reset your ${config.siteConfiguration.siteName} password`,
          "passwordResetCode.ejs",
          {
            username: user.username,
            code,
            expiryMinutes: passwordResetExpiryMinutes,
            siteAddress: process.env.siteAddress,
            siteName: config.siteConfiguration.siteName,
          }
        );

        req.session.passwordReset = {
          userId: user.userId,
          username: user.username,
          email: user.email,
          stage: "CODE",
        };
      } else {
        req.session.passwordReset = {
          stage: "CODE",
        };
      }

      setBannerCookie(
        "success",
        "If an account exists with those details, we've emailed a verification code.",
        res
      );

      return res.redirect(`/forgot-password/verify`);
    } catch (error) {
      logRouteError("start password reset", error);
      setBannerCookie(
        "danger",
        "We couldn't start a password reset right now. Please try again soon.",
        res
      );
      return res.redirect(`/forgot-password`);
    }
  });

  app.get("/forgot-password/verify", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, max: 10 })) return;

    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    const passwordReset = req.session.passwordReset;

    if (!passwordReset || passwordReset.stage !== "CODE") {
      return res.redirect(`/forgot-password`);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/forgotPasswordVerify", {
      pageTitle: `Verify Reset Code`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      username: passwordReset.username,
      expiryMinutes: passwordResetExpiryMinutes,
    }));
    return;
  });

  app.post("/forgot-password/verify", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, max: 10 })) return;

    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    const passwordReset = req.session.passwordReset;

    if (!passwordReset || passwordReset.stage !== "CODE") {
      setBannerCookie(
        "danger",
        "Your reset request could not be found. Please start again.",
        res
      );
      return res.redirect(`/forgot-password`);
    }

    const code = req.body.code ? req.body.code.trim() : "";

    if (!code) {
      setBannerCookie("warning", "Please enter the verification code.", res);
      return res.redirect(`/forgot-password/verify`);
    }

    if (!passwordReset.userId) {
      setBannerCookie("danger", "We couldn't verify that code.", res);
      return res.redirect(`/forgot-password/verify`);
    }

    try {
      const verification = await verifyPasswordResetCode(
        passwordReset.userId,
        code
      );

      if (!verification.valid) {
        let message = "We couldn't verify that code.";

        if (verification.reason === "expired") {
          message = "That code has expired. Please request a new password reset.";
        } else if (verification.reason === "consumed") {
          message = "That code has already been used. Please request a new password reset.";
        }

        setBannerCookie("danger", message, res);
        return res.redirect(`/forgot-password/verify`);
      }

      req.session.passwordReset.stage = "RESET";

      setBannerCookie(
        "success",
        "Code verified! You can now choose a new password.",
        res
      );
      return res.redirect(`/forgot-password/reset`);
    } catch (error) {
      logRouteError("verify password reset code", error);
      setBannerCookie(
        "danger",
        "We couldn't verify that code right now. Please try again soon.",
        res
      );
      return res.redirect(`/forgot-password/verify`);
    }
  });

  app.get("/forgot-password/reset", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    const passwordReset = req.session.passwordReset;

    if (
      !passwordReset ||
      passwordReset.stage !== "RESET" ||
      !passwordReset.userId
    ) {
      return res.redirect(`/forgot-password`);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/resetPassword", {
      pageTitle: `Choose a New Password`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.post("/forgot-password/reset", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.login, req, res, features))
      return;

    const passwordReset = req.session.passwordReset;

    if (
      !passwordReset ||
      passwordReset.stage !== "RESET" ||
      !passwordReset.userId
    ) {
      setBannerCookie(
        "danger",
        "Your reset request could not be found. Please start again.",
        res
      );
      return res.redirect(`/forgot-password`);
    }

    const password = req.body.password || "";
    const confirmPassword = req.body.confirmPassword || "";

    if (!password || !confirmPassword) {
      setBannerCookie("warning", "Please complete all password fields.", res);
      return res.redirect(`/forgot-password/reset`);
    }

    if (password !== confirmPassword) {
      setBannerCookie("danger", "Passwords do not match.", res);
      return res.redirect(`/forgot-password/reset`);
    }

    if (!passwordRequirements.test(password)) {
      setBannerCookie(
        "warning",
        "Password must be at least 8 characters and include uppercase, lowercase and a number.",
        res
      );
      return res.redirect(`/forgot-password/reset`);
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      await updateUserPassword(passwordReset.userId, passwordHash);

      delete req.session.passwordReset;

      setBannerCookie(
        "success",
        "Your password has been reset. You can now sign in.",
        res
      );
      return res.redirect(`/login`);
    } catch (error) {
      logRouteError("complete password reset", error);
      setBannerCookie(
        "danger",
        "We couldn't reset your password right now. Please try again soon.",
        res
      );
      return res.redirect(`/forgot-password/reset`);
    }
  });

  app.get("/register", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.register, req, res, features))
      return;

    if (req.session.user) {
      return res.redirect(`/`);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/register", {
      pageTitle: `Register`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.post("/register", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, max: 5 })) return;

    if (!await isFeatureWebRouteEnabled(app, features.web.register, req, res, features))
      return;

    const username = req.body.username ? req.body.username.trim() : "";
    const email = normaliseEmail(req.body.email);
    const password = req.body.password || "";

    if (!username || !email || !password) {
      setBannerCookie("warning", "All fields are required.", res);
      return res.redirect(`/register`);
    }

    if (!passwordRequirements.test(password)) {
      setBannerCookie(
        "warning",
        "Password must be at least 8 characters and include uppercase, lowercase and a number.",
        res
      );
      return res.redirect(`/register`);
    }

    try {
      const userGetter = new UserGetter();
      const existingUsername = await userGetter.byUsername(username);

      let formattedUuid;
      const isBedrock = username.startsWith(".");

      if (isBedrock) {
        // Bedrock players (Floodgate prefix) are not in the Mojang API.
        // Look up their UUID from the server database instead.
        formattedUuid = await userGetter.getBedrockUuid(username);

        if (!formattedUuid) {
          setBannerCookie(
            "danger",
            "We could not find that Bedrock username. Make sure you have joined the server at least once.",
            res
          );
          return res.redirect(`/register`);
        }
      } else {
        const profileResponse = await fetch(
          `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`
        );

        if (profileResponse.status === 204 || profileResponse.status === 404) {
          setBannerCookie("danger", "We could not find that Minecraft username.", res);
          return res.redirect(`/register`);
        }

        if (!profileResponse.ok) {
          throw new Error("Failed to validate Minecraft username");
        }

        const profileData = await profileResponse.json();
        formattedUuid = formatMojangUuid(profileData.id);
      }

      if (!formattedUuid) {
        setBannerCookie("danger", "Invalid Minecraft UUID returned.", res);
        return res.redirect(`/register`);
      }

      const existingUuidUserRaw = await userGetter.byUUID(formattedUuid);

      // Placeholder ("ghost") rows are created by createUnlinkedUser when a
      // Discord user opens a support ticket before linking a Minecraft
      // account. They must not block a genuine registration for the same
      // person — instead we merge them into the real account further down.
      // A ghost can collide by UUID (rare) or, far more often, by a
      // case-insensitive username match (the Thylakin bug).
      const existingUuidUser =
        existingUuidUserRaw && !existingUuidUserRaw.is_placeholder
          ? existingUuidUserRaw
          : null;

      let placeholderUser =
        existingUuidUserRaw && existingUuidUserRaw.is_placeholder
          ? existingUuidUserRaw
          : await userGetter.placeholderMatch(username, formattedUuid);

      // A real (non-placeholder) username row still blocks registration.
      const blockingUsername =
        existingUsername && !existingUsername.is_placeholder ? existingUsername : null;

      if (
        blockingUsername &&
        (!existingUuidUser || blockingUsername.userId !== existingUuidUser.userId)
      ) {
        setBannerCookie("danger", "That username is already registered.", res);
        return res.redirect(`/register`);
      }

      if (existingUuidUser && existingUuidUser.account_registered && existingUuidUser.password_hash) {
        setBannerCookie("danger", "An account already exists for this Minecraft player.", res);
        return res.redirect(`/register`);
      }

      if (!existingUuidUser) {
        const hasJoinedServer = await userGetter.hasJoined(
          username,
          formattedUuid
        );

        if (!hasJoinedServer) {
          setBannerCookie(
            "danger",
            "You need to join the Minecraft server before creating a website account.",
            res
          );
          return res.redirect(`/register`);
        }
      }

      const existingEmail = await userGetter.byEmail(email);
      if (
        existingEmail &&
        existingEmail.password_hash &&
        existingEmail.account_registered &&
        (!existingUuidUser || existingEmail.userId !== existingUuidUser.userId)
      ) {
        setBannerCookie("danger", "That email address is already in use.", res);
        return res.redirect(`/register`);
      }

      const passwordHash = await bcrypt.hash(password, 12);

      let userId;

      if (existingUuidUser) {
        await updateLocalUserCredentials(existingUuidUser.userId, {
          email,
          passwordHash,
          username,
        });
        userId = existingUuidUser.userId;
      } else if (placeholderUser && placeholderUser.uuid === formattedUuid) {
        // The ghost row already occupies this Minecraft UUID — promote it in
        // place rather than creating a second row (which would hit the
        // users.uuid UNIQUE constraint).
        await updateLocalUserCredentials(placeholderUser.userId, {
          email,
          passwordHash,
          username,
        });
        await clearPlaceholderFlag(placeholderUser.userId);
        userId = placeholderUser.userId;
        placeholderUser = null;
      } else {
        const newUser = await createLocalUser({
          uuid: formattedUuid,
          username,
          email,
          passwordHash,
        });
        userId = newUser.userId;
      }

      if (placeholderUser && placeholderUser.userId !== userId) {
        try {
          const mergeSummary = await mergePlaceholderUser(placeholderUser.userId, userId);
          console.info("[SESSION] Merged placeholder user during registration", mergeSummary);
        } catch (mergeError) {
          logRouteError("merge placeholder user during registration", mergeError);
        }
      }

      const verificationCode = await generateVerificationCode();
      const expiresAt = new Date(Date.now() + emailVerificationExpiryMinutes * 60000);
      await createEmailVerification(userId, verificationCode, expiresAt);

      await sendMail(
        email,
        `${config.siteConfiguration.siteName} Email Verification`,
        "verificationCode.ejs",
        {
          username,
          code: verificationCode,
          expiryMinutes: emailVerificationExpiryMinutes,
          siteName: config.siteConfiguration.siteName,
        }
      );

      req.session.pendingRegistration = {
        userId,
        username,
        email,
        stage: "EMAIL",
      };

      setBannerCookie("success", "We sent a verification code to your email.", res);
      return res.redirect(`/register/verify-email`);
    } catch (error) {
      logRouteError("start registration", error);
      setBannerCookie("danger", "We were unable to create your account.", res);
      return res.redirect(`/register`);
    }
  });

  app.get("/register/verify-email", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.register, req, res, features))
      return;

    const pendingRegistration = req.session.pendingRegistration;

    if (!pendingRegistration || !pendingRegistration.userId) {
      setBannerCookie("warning", "Start by creating an account first.", res);
      return res.redirect(`/register`);
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/registerVerifyEmail", {
      pageTitle: `Verify Email`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      email: pendingRegistration.email,
      expiryMinutes: emailVerificationExpiryMinutes,
    }));
    return;
  });

  app.post("/register/verify-email", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, max: 10 })) return;

    if (!await isFeatureWebRouteEnabled(app, features.web.register, req, res, features))
      return;

    const pendingRegistration = req.session.pendingRegistration;
    if (!pendingRegistration || !pendingRegistration.userId) {
      setBannerCookie("warning", "Start by creating an account first.", res);
      return res.redirect(`/register`);
    }

    const code = [
      req.body.first,
      req.body.second,
      req.body.third,
      req.body.fourth,
      req.body.fifth,
      req.body.sixth,
    ]
      .join("")
      .trim();

    if (code.length !== 6) {
      setBannerCookie("danger", "Please enter the 6 digit code from your email.", res);
      return res.redirect(`/register/verify-email`);
    }

    try {
      const verificationResult = await verifyEmailCode(pendingRegistration.userId, code);

      if (!verificationResult.valid) {
        setBannerCookie("danger", "That verification code is invalid or expired.", res);
        return res.redirect(`/register/verify-email`);
      }

      await markEmailVerified(pendingRegistration.userId);
      req.session.pendingRegistration.stage = "MINECRAFT";

      setBannerCookie(
        "success",
        "Email verified! Now verify your Minecraft account.",
        res
      );
      return res.redirect(`/register/minecraft`);
    } catch (error) {
      logRouteError("verify registration email", error);
      setBannerCookie("danger", "We were unable to verify that code.", res);
      return res.redirect(`/register/verify-email`);
    }
  });

  app.get("/register/minecraft", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.register, req, res, features))
      return;

    const pendingRegistration = req.session.pendingRegistration;

    if (!pendingRegistration || !pendingRegistration.userId) {
      setBannerCookie("warning", "Start by creating an account first.", res);
      return res.redirect(`/register`);
    }

    if (pendingRegistration.stage !== "MINECRAFT") {
      setBannerCookie("warning", "Please verify your email before continuing.", res);
      return res.redirect(`/register/verify-email`);
    }

    const fetchURL = `${process.env.siteAddress}/api/server/get?type=VERIFICATION`;
    const response = await fetch(fetchURL, {
      headers: internalApiHeaders(),
    });
    const apiData = await response.json();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/registerMinecraft", {
      pageTitle: `Verify Minecraft`,
      config: config,
      req: req,
      apiData: apiData,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      pendingUserId: pendingRegistration.userId,
      pendingUsername: pendingRegistration.username || null,
    }));
    return;
  });

  app.post("/register/minecraft", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.register, req, res, features))
      return;

    const pendingRegistration = req.session.pendingRegistration;

    if (!pendingRegistration || !pendingRegistration.userId) {
      setBannerCookie("warning", "Start by creating an account first.", res);
      return res.redirect(`/register`);
    }

    const code = [
      req.body.first,
      req.body.second,
      req.body.third,
      req.body.fourth,
      req.body.fifth,
      req.body.sixth,
    ]
      .join("")
      .trim();

    if (code.length !== 6) {
      setBannerCookie("danger", "Please enter the 6 digit code from the Minecraft server.", res);
      return res.redirect(`/register/minecraft`);
    }

    try {
      const userLinkData = new UserLinkGetter();
      const linkUser = await userLinkData.getUserByCode(code);

      if (!linkUser || linkUser.userId !== pendingRegistration.userId) {
        setBannerCookie(
          "danger",
          "That verification code does not match your account.",
          res
        );
        return res.redirect(`/register/minecraft`);
      }

      await userLinkData.markWebsiteRegistrationComplete(linkUser.uuid);
      await markAccountRegistered(pendingRegistration.userId);

      await hydrateUserSession(req, linkUser);
      delete req.session.pendingRegistration;

      setBannerCookie("success", "Your account has been verified!", res);
      return res.redirect(`${process.env.siteAddress}/`);
    } catch (error) {
      logRouteError("verify Minecraft registration", error);
      setBannerCookie("danger", "Unable to verify that code right now.", res);
      return res.redirect(`/register/minecraft`);
    }
  });

  app.get("/unregistered", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.web.register, req, res, features))
      return;

    const discordId = req.cookies.discordId;
    if (!discordId) return res.redirect(`/`);

    const fetchURL = `${process.env.siteAddress}/api/server/get?type=VERIFICATION`;
    const response = await fetch(fetchURL, {
      headers: internalApiHeaders(),
    });
    const apiData = await response.json();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/unregistered", {
      pageTitle: `Unregistered`,
      config: config,
      req: req,
      apiData: apiData,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      discordId: discordId,
    }));
    return;
  });

  app.get("/auth/refresh-session", async function (req, res) {
    if (!req.session?.user) {
      return res.redirect("/login");
    }

    try {
      const userGetter = new UserGetter();
      const userData = await userGetter.byUserId(req.session.user.userId);

      if (!userData) {
        setBannerCookie("error", "Could not refresh session: user not found.", res);
        return res.redirect("/dashboard");
      }

      await hydrateUserSession(req, userData);
      setBannerCookie("success", "Permissions refreshed successfully.", res);
    } catch (err) {
      logRouteError("refresh session", err);
      setBannerCookie("error", "Failed to refresh permissions. Please try logging out and back in.", res);
    }

    const returnTo = req.headers.referer || "/dashboard";
    return res.redirect(returnTo);
  });

  app.get("/logout", async function (req, res) {
    try {
      await req.session.destroy();
      setBannerCookie("success", lang.session.userLogout, res);
      res.redirect(`${process.env.siteAddress}/`);
    } catch (err) {
      logRouteError("destroy session during logout", err);
      throw err;
    }
  });
}
