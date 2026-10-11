// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
import { postAPIRequest, setBannerCookie } from "../common.js";
import { checkRateLimit } from "../../lib/rateLimiter.mjs";

export default function webRedirectRoute(app, config, lang, features) {
  const baseEndpoint = "/redirect/web";

  // The profile routes below all act on the logged-in user; a request with no
  // session used to throw a TypeError (500) instead of being turned away.
  const requireLogin = (req, res) => {
    if (req.session?.user?.userId) return true;
    res.redirect(`${process.env.siteAddress}/login`);
    return false;
  };

  app.post(baseEndpoint + "/user/link", async function (req, res) {
    // Six digits, five minutes: without a throttle this is brute-forceable.
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, max: 10 })) return;

    // Which Discord account gets linked is decided by the OAuth callback that
    // set the cookie, never by a hidden form field the browser can edit.
    const rawCookie = req.cookies?.discordId;
    const unsigned = rawCookie ? req.unsignCookie(rawCookie) : { valid: false };
    const discordId = unsigned.valid ? unsigned.value : null;
    if (!discordId || !/^\d{15,22}$/.test(String(discordId))) {
      setBannerCookie("warning", "Your Discord sign-in has expired. Please sign in with Discord again.", res);
      return res.redirect(`${process.env.siteAddress}/login`);
    }

    await postAPIRequest(
      `${process.env.siteAddress}/api/user/link`,
      { ...(req.body || {}), discordId },
      `${process.env.siteAddress}/unregistered`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/`);
    }
    return res;
  });

  app.post(baseEndpoint + "/user/profile/display", async function (req, res) {    
    if (!requireLogin(req, res)) return;
    // Add userId to req.body
    req.body.userId = req.session.user.userId;

    // Make the API request
    await postAPIRequest(
      `${process.env.siteAddress}/api/user/profile/display`,
      req.body,
      `${process.env.siteAddress}/`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/profile/${req.session.user.username}`);
    }
    return res;
  });

  app.post(baseEndpoint + "/user/profile/personal", async function (req, res) {
    if (!requireLogin(req, res)) return;
    req.body.userId = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/user/profile/personal`,
      req.body,
      `${process.env.siteAddress}/`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/profile/${req.session.user.username}`);
    }
    return res;
  });

  app.post(baseEndpoint + "/user/profile/interests", async function (req, res) {
    if (!requireLogin(req, res)) return;
    // Add userId to req.body
    req.body.userId = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/user/profile/interests`,
      req.body,
      `${process.env.siteAddress}/`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/profile/${req.session.user.username}`);
    }
    return res;
  });

  app.post(baseEndpoint + "/user/profile/about", async function (req, res) {
    if (!requireLogin(req, res)) return;
    // Add userId to req.body
    req.body.userId = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/user/profile/about`,
      req.body,
      `${process.env.siteAddress}/`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/profile/${req.session.user.username}`);
    }
    return res;
  });

  app.post(baseEndpoint + "/user/profile/social", async function (req, res) {
    if (!requireLogin(req, res)) return;
    // Add userId to req.body
    req.body.userId = req.session.user.userId;
    
    await postAPIRequest(
      `${process.env.siteAddress}/api/user/profile/social`,
      req.body,
      `${process.env.siteAddress}/`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/profile/${req.session.user.username}`);
    }
    return res;
  });
}
