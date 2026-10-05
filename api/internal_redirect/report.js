// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
import { postAPIRequest } from "../common.js";

export default function reportRedirectRoute(app, config, lang, features) {
  const baseEndpoint = "/redirect/report";

  app.post(baseEndpoint + "/create", async function (req, res) {
    req.body.reporterUser = req.session.user.username;

    await postAPIRequest(
      `${process.env.siteAddress}/api/report/create`,
      req.body,
      `${process.env.siteAddress}/report`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/`);
    }
    return res;
  });
}
