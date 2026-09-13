// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
import { hasPermission, postAPIRequest, setBannerCookie } from "../common.js";

export default function bridgeRedirectRoute(app, config, lang, features) {
  const baseEndpoint = "/redirect/bridge";

  function parseJsonPayload(source, fieldName, res) {
    if (!source[fieldName]) return null;

    try {
      const parsed = JSON.parse(source[fieldName]);
      delete source[fieldName];
      return parsed;
    } catch (error) {
      setBannerCookie(
        "warning",
        `We could not parse the ${fieldName.replace("JSON", "").trim()} JSON payload.`,
        res
      );
      return null;
    }
  }

  async function forwardRequest(apiPath, req, res) {
    await postAPIRequest(
      `${process.env.siteAddress}${apiPath}`,
      req.body,
      `${process.env.siteAddress}/dashboard/bridge`,
      res
    );

    if (!res.sent) {
      return res.redirect(`${process.env.siteAddress}/dashboard/bridge`);
    }
  }

  app.post(`${baseEndpoint}/command/add`, async function (req, res) {
    if (!(await hasPermission("zander.web.bridge", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    const tasksPayload = parseJsonPayload(req.body, "tasksJSON", res);
    const metadataPayload = parseJsonPayload(req.body, "metadataJSON", res);

    if (tasksPayload) {
      req.body.tasks = tasksPayload;
    }

    if (metadataPayload) {
      req.body.metadata = metadataPayload;
    }

    return forwardRequest(
      "/api/bridge/processor/command/add",
      req,
      res
    );
  });

  app.post(`${baseEndpoint}/routine/run`, async function (req, res) {
    if (!(await hasPermission("zander.web.bridge", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    const metadataPayload = parseJsonPayload(req.body, "metadataJSON", res);
    if (metadataPayload) {
      req.body.metadata = metadataPayload;
    }

    return forwardRequest(
      "/api/bridge/processor/command/add",
      req,
      res
    );
  });

  app.post(`${baseEndpoint}/routine/save`, async function (req, res) {
    if (!(await hasPermission("zander.web.bridge", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    const stepsPayload = parseJsonPayload(req.body, "stepsJSON", res);
    if (stepsPayload) {
      req.body.steps = stepsPayload;
    }

    return forwardRequest("/api/bridge/routine/save", req, res);
  });

  app.post(`${baseEndpoint}/task/reset`, async function (req, res) {
    if (!(await hasPermission("zander.web.bridge", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    return forwardRequest(
      `/api/bridge/processor/task/${req.body.taskId}/reset`,
      req,
      res
    );
  });

  app.post(`${baseEndpoint}/task/report`, async function (req, res) {
    if (!(await hasPermission("zander.web.bridge", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    const metadataPayload = parseJsonPayload(req.body, "metadataJSON", res);
    const taskId = req.body.taskId;

    delete req.body.taskId;

    if (metadataPayload) {
      req.body.metadata = metadataPayload;
    }

    return forwardRequest(
      `/api/bridge/processor/task/${taskId}/report`,
      req,
      res
    );
  });

  app.post(`${baseEndpoint}/queue/clear`, async function (req, res) {
    if (!(await hasPermission("zander.web.bridge", req, res, features))) return;

    req.body.actioningUser = req.session.user.userId;

    return forwardRequest(
      "/api/bridge/processor/clear",
      req,
      res
    );
  });
}
