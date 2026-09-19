/**
 * Content Security Policy support.
 *
 * Why an onSend rewrite rather than template nonces: this codebase renders
 * through the *instance* decorator (`app.view(...)` — 126 call sites) far more
 * than the reply decorator (`res.view(...)` — 5). @fastify/view only merges
 * `reply.locals` into the reply-decorator path, so a per-request nonce cannot
 * reach the instance-rendered templates without editing every call site.
 * Stamping the nonce onto the finished HTML works identically for both paths
 * and keeps the change to a single hook.
 *
 * The policy ships as Content-Security-Policy-REPORT-ONLY. Browsers never
 * block on a report-only policy, so this cannot break the site; it reports
 * what *would* have been blocked so the policy can be tightened against real
 * traffic before it is enforced. See buildContentSecurityPolicy() for the
 * remaining work needed before flipping to enforcement.
 */

import crypto from "crypto";

/** Per-request nonce. 16 bytes is the CSP spec's recommended minimum (128 bits). */
export function generateNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Hosts the views actually reference, inventoried from the templates rather
 * than guessed. Keep these in sync when a new CDN or embed is introduced.
 */
export const CSP_SOURCES = {
  script: [
    "https://cdn.jsdelivr.net",
    "https://cdnjs.cloudflare.com",
    "https://code.jquery.com",
    "https://cdn.datatables.net",
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
  ],
  style: [
    "https://cdn.jsdelivr.net",
    "https://cdnjs.cloudflare.com",
    "https://cdn.datatables.net",
    "https://fonts.googleapis.com",
  ],
  font: ["https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
  // Every host the app can put in an <img src>.  Missing entries do not show
  // up while the policy is report-only, so this list is easy to let rot --
  // gravatar, mc-heads and Cloudinary were all absent, which would have
  // blanked every avatar and every uploaded event banner the moment the
  // header was switched to enforcing.
  img: [
    "https://crafatar.com",
    "https://crafthead.net",
    "https://cdn.discordapp.com",
    "https://i.imgur.com",
    // Avatars: controllers/userController.js, forumController.js,
    // staffController.js, supportTicketController.js, lib/avatarHelpers.js.
    "https://gravatar.com",
    "https://secure.gravatar.com",
    // Minecraft head renders: controllers/staffController.js.
    "https://mc-heads.net",
    // Everything uploaded through /api/upload/image comes back on this host
    // (services/cloudinaryService.js returns secure_url) -- event banners and
    // logos, announcement art, rank catalogue images.
    "https://res.cloudinary.com",
  ],
  connect: ["https://www.google-analytics.com"],
  frame: ["https://www.youtube.com", "https://player.vimeo.com", "https://discord.com"],
};

/**
 * Build the policy string.
 *
 * Known gaps that must be closed before this can be enforced:
 *   - script-src carries no 'unsafe-inline' fallback, so the ~24 inline event
 *     handler attributes in views/ (onclick=, onsubmit=, ...) will be reported.
 *     Nonces cannot cover attribute handlers; those need moving into script
 *     blocks, or 'unsafe-hashes' with an explicit hash for each.
 *   - style-src keeps 'unsafe-inline' because the views carry ~356 inline
 *     style attributes, which nonces also cannot cover. Closing that is a
 *     larger refactor and is a much lower risk than inline script.
 *
 * @param {string} nonce - value from generateNonce()
 * @param {{reportUri?: string}} [options]
 */
export function buildContentSecurityPolicy(nonce, { reportUri } = {}) {
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' ${CSP_SOURCES.script.join(" ")}`,
    `style-src 'self' 'unsafe-inline' ${CSP_SOURCES.style.join(" ")}`,
    `font-src 'self' data: ${CSP_SOURCES.font.join(" ")}`,
    `img-src 'self' data: blob: ${CSP_SOURCES.img.join(" ")}`,
    `connect-src 'self' ${CSP_SOURCES.connect.join(" ")}`,
    `frame-src 'self' ${CSP_SOURCES.frame.join(" ")}`,
    // Clickjacking protection; complements the X-Frame-Options helmet sets.
    `frame-ancestors 'self'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ];

  if (reportUri) directives.push(`report-uri ${reportUri}`);

  return directives.join("; ");
}

// <script  — but not </script, and not one that already carries a nonce.
const SCRIPT_TAG = /<script\b(?![^>]*\bnonce=)/gi;

/**
 * Stamp the request nonce onto every <script> tag in a rendered document.
 * Tags that already carry a nonce are left alone so this is idempotent.
 *
 * @param {string} html
 * @param {string} nonce
 * @returns {string}
 */
export function injectNonce(html, nonce) {
  if (typeof html !== "string" || !nonce) return html;
  return html.replace(SCRIPT_TAG, `<script nonce="${nonce}"`);
}

/** True for responses whose body should have nonces stamped into it. */
export function isHtmlResponse(contentType) {
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
}

/**
 * Build the onSend hook that stamps nonces and sets the report-only header.
 *
 * Exported as a factory so app.js and the tests exercise the same code.
 *
 * The nonce is derived here rather than in an onRequest hook because earlier
 * onRequest hooks (the database maintenance page) can short-circuit a request
 * with a reply, so a later onRequest hook never runs while onSend still fires.
 * Deriving it here keeps header and body in step on every response.
 *
 * @param {{reportUri?: string, enforce?: boolean}} [options]
 *   enforce=false (the default) sends Content-Security-Policy-Report-Only,
 *   which browsers never block on. Flip to true only once the reports are
 *   clean — see buildContentSecurityPolicy() for what is still outstanding.
 */
export function createCspOnSendHook({ reportUri, enforce = false } = {}) {
  const header = enforce
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

  return async function cspOnSend(req, res, payload) {
    if (!isHtmlResponse(res.getHeader("content-type")) || typeof payload !== "string") {
      return payload;
    }

    const nonce = generateNonce();
    const stamped = injectNonce(payload, nonce);

    res.header(header, buildContentSecurityPolicy(nonce, { reportUri }));

    // The rewrite lengthens the body, so the declared length must follow it or
    // the client truncates the document.
    if (stamped !== payload) {
      res.header("content-length", Buffer.byteLength(stamped));
    }

    return stamped;
  };
}

/**
 * Register the content types browsers actually use to post CSP violations.
 *
 * CSP Level 2 sends "application/csp-report"; the Reporting API sends
 * "application/reports+json".  Fastify's built-in parser claims neither, so
 * without this every report came back 415 and the report-only policy silently
 * collected nothing -- the one thing report-only mode exists to do.
 *
 * A malformed body resolves to an empty object rather than an error: the
 * endpoint is unauthenticated and only logs, so a bad report is dropped
 * quietly instead of becoming a 400.
 */
export function registerCspReportParser(app) {
  app.addContentTypeParser(
    ["application/csp-report", "application/reports+json"],
    { parseAs: "string" },
    function (req, body, done) {
      try {
        done(null, body ? JSON.parse(body) : {});
      } catch {
        done(null, {});
      }
    }
  );
}

/**
 * Flatten a posted CSP report body into a list of {directive, blocked, document}.
 *
 * Three shapes arrive in practice: CSP Level 2 ({"csp-report": {...}}), the
 * Reporting API (an array of {type, body}), and a bare object.  Returns only
 * the entries that name a directive, since one without is nothing to act on.
 */
export function normaliseCspReports(payload) {
  const body = payload ?? {};
  const entries = Array.isArray(body)
    ? body.map((entry) => entry?.body ?? entry)
    : [body["csp-report"] ?? body];

  const out = [];
  for (const report of entries) {
    if (!report || typeof report !== "object") continue;

    const directive = report["violated-directive"] || report.effectiveDirective;
    if (!directive) continue;

    out.push({
      directive,
      blocked: report["blocked-uri"] || report.blockedURL || null,
      document: report["document-uri"] || report.documentURL || null,
    });
  }
  return out;
}
