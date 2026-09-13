// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
import { hasPermission, postAPIRequest } from "../common.js";

export default function applicationRedirectRoute(app, config, lang, features) {
  const baseEndpoint = "/redirect/applications";

  app.post(baseEndpoint + "/create", async function (req, res) {
    if (!(await hasPermission("zander.web.application", req, res, features))) return;

    // Add userId to req.body
    req.body.actioningUser = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/application/create`,
      req.body,
      `${process.env.siteAddress}/dashboard/applications`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/dashboard/applications`);
    }
    return res;
  });

  app.post(baseEndpoint + "/edit", async function (req, res) {
    if (!(await hasPermission("zander.web.application", req, res, features))) return;

    // Add userId to req.body
    req.body.actioningUser = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/application/edit`,
      req.body,
      `${process.env.siteAddress}/dashboard/applications`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/dashboard/applications`);
    }
    return res;
  });

  app.post(baseEndpoint + "/delete", async function (req, res) {
    if (!(await hasPermission("zander.web.application", req, res, features))) return;

    // Add userId to req.body
    req.body.actioningUser = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/application/delete`,
      req.body,
      `${process.env.siteAddress}/dashboard/applications`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/dashboard/applications`);
    }
    return res;
  });
}
