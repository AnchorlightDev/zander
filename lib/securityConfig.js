/**
 * Central security configuration shared by app.js and its tests.
 *
 * Kept in one module so the exact options the server registers are the ones
 * under test, rather than a copy that can drift.
 */

/**
 * True when the site is served over TLS, derived from siteAddress so local
 * http development keeps working while any https deployment is hardened.
 *
 * @param {string|undefined} siteAddress - process.env.siteAddress
 * @returns {boolean}
 */
export function isHttpsDeployment(siteAddress) {
  return String(siteAddress || "")
    .trim()
    .toLowerCase()
    .startsWith("https://");
}

/**
 * Options for @fastify/helmet.
 *
 * contentSecurityPolicy is disabled deliberately: the views ship dozens of
 * inline <script> blocks and hundreds of inline style attributes, so any CSP
 * without 'unsafe-inline' blanks the site. Enabling it requires nonce-ing those
 * inline blocks first — tracked as follow-up work, not a silent default.
 *
 * @param {boolean} https - result of isHttpsDeployment()
 */
export function buildHelmetOptions(https) {
  return {
    contentSecurityPolicy: false,
    // Assets are same-origin and some dashboard views pull avatars from
    // crafatar; COEP would block those sub-resources.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // HSTS only makes sense once TLS is actually terminating in front of us,
    // and sending it over plain http is ignored by browsers anyway.
    hsts: https ? { maxAge: 15552000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  };
}

/**
 * Whether a cookie-authenticated, state-changing request came from another
 * site. Browsers that send Sec-Fetch-Site answer directly; otherwise the
 * Origin header (or, failing that, the Referer) must match the site origin.
 * Requests with none of the three are treated as same-site so non-browser
 * clients that carry a session (tests, scripted admin tools) keep working.
 *
 * @param {object} req - Fastify request
 * @param {string|undefined} siteAddress - process.env.siteAddress
 * @returns {boolean}
 */
export function isCrossSiteRequest(req, siteAddress) {
  const fetchSite = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "same-origin" || fetchSite === "none") return false;
  if (fetchSite === "cross-site" || fetchSite === "same-site") return true;

  let siteOrigin = null;
  try {
    siteOrigin = new URL(siteAddress).origin;
  } catch {
    return false; // misconfigured siteAddress: do not lock everyone out
  }

  const origin = req.headers?.origin;
  if (origin) return origin !== siteOrigin;

  const referer = req.headers?.referer;
  if (!referer) return false;
  try {
    return new URL(referer).origin !== siteOrigin;
  } catch {
    return true;
  }
}

/**
 * Cookie options for @fastify/session.
 *
 * @param {boolean} https - result of isHttpsDeployment()
 */
export function buildSessionCookieOptions(https) {
  return {
    // Without Secure the session id travels in cleartext on any non-TLS hop.
    secure: https,
    maxAge: 86400000 * 7, // 7 days default
    httpOnly: true,
    sameSite: "lax",
  };
}
