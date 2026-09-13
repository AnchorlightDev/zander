// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
import { hasPermission, postAPIRequest } from "../common.js";

export default function schedulerRedirectRoute(app, config, lang, features) {
  const baseEndpoint = "/redirect/scheduler";

  app.post(baseEndpoint + "/discord/create", async function (req, res) {
    if (!(await hasPermission("zander.web.scheduler", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/scheduler/discord/create`,
      req.body,
      `${process.env.siteAddress}/dashboard/scheduler`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/dashboard/scheduler`);
    }
    return res;
  });

  app.post(baseEndpoint + "/discord/delete", async function (req, res) {
    if (!(await hasPermission("zander.web.scheduler", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    await postAPIRequest(
      `${process.env.siteAddress}/api/scheduler/discord/delete`,
      req.body,
      `${process.env.siteAddress}/dashboard/scheduler`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/dashboard/scheduler`);
    }
    return res;
  });
}
