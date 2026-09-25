import "./instrument.mjs";
import * as Sentry from "@sentry/node";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Prevent unhandled promise rejections (e.g. Discord API / webhook errors) from
// crashing the process. Fastify handles errors within request handlers, but
// bot listeners and cron jobs run outside that lifecycle.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[UNHANDLED REJECTION]", promise, "Reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION]", error);
});

// Fan every console.error / console.warn (and the two handlers above) out to a
// throttled email to the system admin. No-op unless adminErrorEmail + smtpHost
// are set in .env. Installed early so nothing logged during boot is missed.
import { installGlobalErrorReporting, reportError } from "./controllers/errorReporterController.js";
installGlobalErrorReporting();

const packageData = require("./package.json");
import moment from "moment";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

import fastify from "fastify";
import fastifySession from "@fastify/session";
import fastifyCookie from "@fastify/cookie";
import { FastifyPrismaSessionStore } from "./lib/fastifyPrismaSessionStore.js";
import {
  isHttpsDeployment as detectHttpsDeployment,
  buildHelmetOptions,
  buildSessionCookieOptions,
} from "./lib/securityConfig.js";
import { checkRateLimit } from "./lib/rateLimiter.mjs";
import { getRegion } from "./lib/region.mjs";
import {
  createCspOnSendHook,
  registerCspReportParser,
  normaliseCspReports,
} from "./lib/csp.js";

const config = require("./config.json");

// Derived config, computed once at boot.
//
// `config` already reaches every template, and @fastify/view does not merge
// reply.locals into the app.view() path this codebase renders through (see the
// CSP note further down). Normalising here is what lets the shared header read
// one consistent region without threading a new local through 126 render calls.
// getRegion is idempotent, so re-running it over its own output is harmless.
config.siteConfiguration = config.siteConfiguration || {};
config.siteConfiguration.region = getRegion(config);

const features = require("./features.json");
const lang = require("./lang.json");
import db, { isDbHealthy, prisma } from "./controllers/databaseController.js";
import { getWebAnnouncement } from "./controllers/announcementController.js";
import { getNotificationSummary } from "./controllers/notificationController.js";
import { applyConfigOverrides, startConfigSync } from "./controllers/configSettingsController.js";

// Paths
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dashboard-edited settings (/dashboard/settings) are overlaid onto the shared
// config object before the Discord client and cron jobs load, because a few of
// them copy config values once at import time.
await applyConfigOverrides();
startConfigSync();

import("./controllers/discordController.js");
import("./cron/userCodeExpiryCron.js");
import("./cron/bridgeCleanupCron.js");
import("./cron/cakeDayUserCheck.js");
import("./cron/birthdayRankCron.js");
import("./cron/staffAuditReportCron.js");
import("./cron/schedulerCron.js");
import("./cron/nicknameCheckCron.js");
import("./cron/punishmentExpiryCron.js");
import("./cron/watchTwitchCron.js");
import("./cron/watchYoutubeCron.js");
import("./cron/unverifiedReminderCron.js");
// eventAnnouncementCron removed — event announcements now use scheduledDiscordMessages via schedulerCron
import("./cron/eventTemplateCron.js");
import("./cron/announcementExpiryCron.js");
import("./cron/webstoreCommandSyncCron.js");
import("./cron/badgeLuckpermsSyncCron.js");
import("./cron/rankDiscordRoleSyncCron.js");
import("./cron/shopItemIndexCron.js");

//
// Website Related
//

// Site Routes
import siteRoutes from "./routes/index.js";
import apiRoutes from "./api/routes/index.js";
import uploadApiRoute from "./api/routes/upload.js";
import apiRedirectRoutes from "./api/internal_redirect/index.js";
import webstoreWebhookRoutes from "./api/internal_redirect/webstore.js";
import configApiRoute from "./api/routes/config.js";

// API token authentication
import verifyToken from "./api/routes/verifyToken.js";
import { getGlobalImage } from "./api/common.js";
import { client } from "./controllers/discordController.js";

function isExpectedClientError(error, statusCode) {
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return true;
  }

  return error?.code === "ERR_HTTP_HEADERS_SENT";
}

//
// Application Boot
//
const buildApp = async () => {
  // pluginTimeout raised to 120 s (default is 10 s).
  // The Sapphire Framework's ApplicationCommandRegistries initialisation can
  // take 60+ seconds while registering Discord slash commands, which can delay
  // event-loop ticks long enough for avvio to fire the default 10-second
  // timeout before route-registration plugins have a chance to complete.
  // trustProxy: the app is deployed behind a TLS-terminating reverse proxy
  // (see Procfile).  Without it req.protocol is always "http", which both
  // defeats secure-cookie issuance below and makes req.ip the proxy address
  // rather than the client's — breaking per-IP rate limiting.
  const app = fastify({
    logger: config.debug,
    pluginTimeout: 120000,
    trustProxy: true,
  });

  // Drives both the Secure flag on the session cookie and HSTS below, so local
  // http development still works while any https deployment is hardened.
  const isHttpsDeployment = detectHttpsDeployment(process.env.siteAddress);

  if (process.env.SENTRY_DSN) {
    Sentry.setupFastifyErrorHandler(app, {
      shouldHandleError(error, _request, reply) {
        if (isExpectedClientError(error, reply?.statusCode)) {
          return false;
        }

        return typeof reply?.statusCode === "number"
          ? reply.statusCode >= 500
          : true;
      },
    });
  }

  // When app errors, render the error on a page, do not provide JSON
  app.setNotFoundHandler(async function (req, res) {
    res.status(404);

    try {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notFound", {
          pageTitle: `404 Not Found`,
          config: config,
          req: req,
          features: features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        })
      );
    } catch (viewError) {
      app.log.error(viewError);
      res.send("404 Not Found");
    }
  });

  // When app errors, render the error on a page, do not provide JSON
  app.setErrorHandler(async function (error, req, res) {
    if (res.sent) {
      // ERR_HTTP_HEADERS_SENT is an expected side-effect of HEAD requests:
      // @fastify/session's async Prisma save resolves after headRouteOnSendHandler
      // already committed the response, so the Set-Cookie write races the finalize.
      // Nothing to do — the response was delivered correctly.
      if (error.code !== "ERR_HTTP_HEADERS_SENT") {
        app.log.warn({ err: error }, "error after reply already sent");
      }
      return;
    }

    const statusCode =
      typeof error?.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500;

    if (isExpectedClientError(error, statusCode)) {
      app.log.info(
        {
          err: {
            message: error?.message,
            code: error?.code,
            statusCode,
          },
          method: req.method,
          url: req.url,
        },
        "request rejected"
      );
    } else {
      app.log.error(error);
      // pino's app.log.error bypasses the console patch, so mail 5xx explicitly.
      if (statusCode >= 500) {
        reportError({
          source: "fastify",
          error,
          meta: { method: req.method, url: req.url, statusCode },
        });
      }
    }

    res.status(statusCode);

    // If the request is for the API, return JSON instead of a view
    if (req.url.startsWith("/api/")) {
      return res.send({
        success: false,
        message: error.message || "Internal Server Error",
      });
    }

    try {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
          pageTitle: `Server Error`,
          config: config,
          error: error,
          req: req,
          features: features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        })
      );
    } catch (viewError) {
      app.log.error(viewError);
      res.send("Internal Server Error");
    }
  });

  // Show a maintenance page instead of hanging when the database is unreachable.
  // Runs before session handling so no DB access is attempted.
  // The maintenance view is self-contained (CDN-only CSS) so the browser
  // will not make further requests to this server for stylesheets or scripts.
  app.addHook("onRequest", async (req, res) => {
    if (isDbHealthy() !== false) return; // up or not-yet-known: let through
    if (req.url === "/api/heartbeat") return; // allow monitoring to detect the outage

    res.status(503);

    // API callers get JSON; browsers get the maintenance page
    if (req.url.startsWith("/api/")) {
      return res.send({ success: false, message: "Service temporarily unavailable. The database is unreachable." });
    }

    try {
      return res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/maintenance", {
          pageTitle: "Down for Maintenance",
          config,
        })
      );
    } catch {
      return res.send("<h1>Down for Maintenance</h1><p>We'll be back shortly.</p>");
    }
  });

  // Security headers.  Options live in lib/securityConfig.js so the exact
  // object registered here is the one covered by tests.
  await app.register(
    await import("@fastify/helmet"),
    buildHelmetOptions(isHttpsDeployment)
  );

  // Content Security Policy — REPORT-ONLY.
  //
  // Browsers never block on a report-only policy, so this cannot break a page;
  // it reports what would have been blocked so the policy can be tightened
  // against real traffic first. See lib/csp.js for what must be closed before
  // switching the header name to Content-Security-Policy.
  //
  // The nonce is stamped onto the finished HTML rather than passed through the
  // templates because this codebase renders via app.view() (the instance
  // decorator) in 126 places, which @fastify/view does not merge reply.locals
  // into. Rewriting on the way out covers every render path identically.
  app.addHook(
    "onSend",
    createCspOnSendHook({ reportUri: "/api/csp-report", enforce: false })
  );

  // EJS Rendering Engine
  await app.register(await import("@fastify/view"), {
    engine: {
      ejs: await import("ejs"),
    },
    root: path.join(__dirname, "views"),
  });

  await app.register(await import("@fastify/static"), {
    root: path.join(__dirname, "assets"),
    prefix: "/",
  });

  await app.register(await import("@fastify/formbody"), { bodyLimit: 10485760 }); // 10 MB
  await app.register(await import("@fastify/multipart"));

  await app.register((instance, options, next) => {
    // API routes (Token authenticated)
    try {
      instance.addHook("preValidation", verifyToken);
      apiRoutes(instance, client, moment, config, db, features, lang);
    } catch (err) {
      return next(err);
    }
    next();
  });

  registerCspReportParser(app);

  // CSP violation collector — public by necessity: the browser posts these
  // with no credentials. Rate limited because it is an unauthenticated write
  // path, and only the fields worth acting on are logged.
  app.post(
    "/api/csp-report",
    { config: { rawBody: false } },
    async function (req, res) {
      if (!checkRateLimit(req, res, { windowMs: 60_000, max: 60 })) return;

      for (const report of normaliseCspReports(req.body)) {
        app.log.warn(report, "[CSP] report-only violation");
      }

      // 204: the browser ignores the body and this keeps the endpoint cheap.
      return res.status(204).send();
    }
  );

  // Heartbeat — public, no token required so monitoring tools can reach it
  app.get("/api/heartbeat", async function (req, res) {
    return res.send({
      success: true,
      message: `OK`,
    });
  });

  // Browser image upload endpoint (/api/upload/image) — session-authenticated
  // inside its own handler, not API-token-authenticated. Registered outside the
  // verifyToken plugin so logged-in dashboard users / form submitters can upload
  // images without the client needing to know the machine API key.
  uploadApiRoute(app, config, db, features, lang);

  // Dashboard image upload — session-authenticated, not API-token-authenticated.
  // Kept outside the verifyToken plugin so logged-in dashboard users can upload
  // images (e.g. popup announcement banners) without needing the machine API key.
  app.post("/dashboard/upload/image", async function (req, res) {
    if (!req.session?.user) {
      return res.status(401).send({ success: false, message: "Authentication required." });
    }

    const { isCloudinaryConfigured, uploadImage } = await import("./services/cloudinaryService.js");

    if (!isCloudinaryConfigured()) {
      return res.status(503).send({ success: false, message: "Image uploads are not configured." });
    }

    const MAX_SIZE  = 8 * 1024 * 1024;
    const ALLOWED   = ["image/png", "image/jpeg", "image/gif", "image/webp"];

    let data;
    try { data = await req.file(); } catch {
      return res.status(400).send({ success: false, message: "No file provided." });
    }
    if (!data?.file) {
      return res.status(400).send({ success: false, message: "No file provided." });
    }
    if (!ALLOWED.includes(data.mimetype)) {
      return res.status(400).send({ success: false, message: "Invalid file type. Allowed: PNG, JPG, GIF, WebP." });
    }

    const folder = data.fields?.folder?.value || "zander";

    try {
      const chunks = [];
      let total = 0;
      for await (const chunk of data.file) {
        total += chunk.length;
        if (total > MAX_SIZE) {
          return res.status(413).send({ success: false, message: "File too large. Maximum 8 MB." });
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const result = await uploadImage(buffer, { folder });
      return res.send({ success: true, data: { url: result.url, publicId: result.publicId, width: result.width, height: result.height } });
    } catch (error) {
      console.error("[upload] Cloudinary upload failed:", error);
      return res.status(500).send({ success: false, message: "Upload failed. Please try again." });
    }
  });

  await app.register((instance, options, next) => {
    // Don't authenticate the Redirect routes. These are
    // protected by
    try {
      apiRedirectRoutes(instance, config, lang, features);
    } catch (err) {
      return next(err);
    }
    next();
  });

  // Stripe webhook — needs raw body for HMAC-SHA256 signature verification.
  // Registered in its own plugin scope with a buffer content-type parser so
  // the raw bytes are preserved; all other routes continue to use the normal
  // JSON parser registered by @fastify/formbody above.
  await app.register((instance, options, next) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body)
    );
    try {
      webstoreWebhookRoutes(instance, config);
    } catch (err) {
      return next(err);
    }
    next();
  });

  await app.register(
    async (instance) => {
      // Config API routes (No token authentication)
      configApiRoute(instance, config, db, features, lang);
    },
    { prefix: "/api/config" }
  );

  // Sessions — persisted via Prisma so logins survive app restarts.
  // The sessions table is created by the baseline migration.
  const sessionStore = new FastifyPrismaSessionStore();

  await app.register(fastifyCookie, {
    secret: process.env.sessionCookieSecret, // for cookies signature
  });

  await app.register(fastifySession, {
    cookieName: "sessionId",
    secret: process.env.sessionCookieSecret,
    store: sessionStore,
    cookie: buildSessionCookieOptions(isHttpsDeployment),
    saveUninitialized: false,
    // rolling: false — do not refresh the session cookie / extend TTL on every
    // read-only request.  Without this, @fastify/session calls store.touch()
    // on EVERY authenticated page load, blocking the onSend pipeline until
    // Prisma completes a DB write — the primary cause of blank pages under
    // any transient DB latency.  Sessions still expire 7 days after last
    // write (login, perm change, etc.).
    rolling: false,
  });

  // Must be registered before siteRoutes so it applies to all site route
  // handlers. Setting req.session.authenticated (which was never read anywhere)
  // has been removed — it caused @fastify/session to treat every request as a
  // modified session and trigger a Prisma INSERT on every request, including
  // unauthenticated ones. On Prisma cold-start this INSERT hangs, holding up
  // the onSend pipeline and producing a blank page on first load.
  app.addHook("preHandler", async (req, res) => {
    req.notifications = { unreadCount: 0, items: [] };

    if (req.session?.user?.userId) {
      try {
        req.notifications = await getNotificationSummary(req.session.user.userId, 5);
      } catch (error) {
        app.log.error(error);
      }
    }
  });

  await app.register((instance, options, next) => {
    // Routes
    try {
      siteRoutes(instance, client, fetch, moment, config, db, features, lang);
    } catch (err) {
      return next(err);
    }
    next();
  });

  // Warm up the Prisma connection pool before accepting requests so the first
  // visitor does not trigger a cold-start DB connection during the onSend
  // session-save phase, which could delay or silently drop the response.
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log("[DB] Prisma connection warmed up.");
  } catch (err) {
    console.warn("[DB] Prisma warm-up query failed (will retry on first request):", err.message);
  }

  // ── Auto-migration: supportTicketMessages charset → utf8mb4 (emoji support) ──
  if (db) {
    try {
      await new Promise((resolve) => {
        db.query(
          `SELECT CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'supportTicketMessages' AND COLUMN_NAME = 'message'`,
          (err, results) => {
            if (err || !results || results.length === 0) return resolve();
            if (results[0].CHARACTER_SET_NAME === 'utf8mb4') return resolve();
            db.query(
              `ALTER TABLE supportTicketMessages CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
              (alterErr) => {
                if (alterErr) {
                  console.warn("[DB] supportTicketMessages charset migration skipped:", alterErr.message);
                } else {
                  console.log("[DB] supportTicketMessages converted to utf8mb4 for emoji support.");
                }
                resolve();
              }
            );
          }
        );
      });
    } catch (err) {
      console.error("[DB] supportTicketMessages auto-migration error:", err.message);
    }
  }

  try {
    const port = process.env.PORT;

    app.listen({ port: port, host: "0.0.0.0" }, (err) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
    });

    console.log(
      `\n// ${packageData.name} v.${packageData.version}\nGitHub Repository: ${packageData.homepage}\nCreated By: ${packageData.author}`
    );
    console.log(`Site and API is listening to the port ${process.env.PORT}`);
  } catch (error) {
    app.log.error(`Unable to start the server:\n${error}`);
  }
};

// If buildApp() rejects (e.g. a plugin registration failure), log the full
// error and exit so the process manager (Render) restarts the service
// immediately rather than leaving it running silently with no open port.
buildApp().catch((err) => {
  console.error("[FATAL] buildApp() failed — exiting:", err);
  process.exit(1);
});
