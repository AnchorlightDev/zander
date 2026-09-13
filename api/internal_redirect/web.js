// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
import { postAPIRequest } from "../common.js";

export default function webRedirectRoute(app, config, lang, features) {
  const baseEndpoint = "/redirect/web";

  app.post(baseEndpoint + "/user/link", async function (req, res) {
    await postAPIRequest(
      `${process.env.siteAddress}/api/user/link`,
      req.body,
      `${process.env.siteAddress}/unregistered`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/`);
    }
    return res;
  });

  app.post(baseEndpoint + "/user/profile/display", async function (req, res) {    
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

  app.post(baseEndpoint + "/user/profile/interests", async function (req, res) {
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
