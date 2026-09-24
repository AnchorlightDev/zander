// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
import fetch from "node-fetch";

import { internalApiHeaders } from "../common.js";
function ensureRankPermission(req, res) {
  const permissions = req.session?.user?.permissions;

  if (!Array.isArray(permissions)) {
    res.code(401).send({
      success: false,
      message: "You must be signed in to manage ranks.",
    });
    return false;
  }

  if (!permissions.includes("zander.web.rank")) {
    res.code(403).send({
      success: false,
      message: "You do not have permission to manage ranks.",
    });
    return false;
  }

  return true;
}

async function forwardJson(path, options = {}) {
  const { method = "POST", body = {} } = options;

  const response = await fetch(`${process.env.siteAddress}${path}`, {
    method,
    headers: internalApiHeaders({ "Content-Type": "application/json" }),
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

  const data = await response.json();
  return { data, status: response.status };
}

export default function rankRedirectRoute(app) {
  const baseEndpoint = "/redirect/rank";

  app.post(`${baseEndpoint}/config/save`, async function (req, res) {
    if (!ensureRankPermission(req, res)) return;

    const { rankSlug, ...payload } = req.body || {};

    if (!rankSlug) {
      return res.code(400).send({
        success: false,
        message: "Rank slug is required.",
      });
    }

    payload.actor = req.session?.user?.username || null;

    try {
      const { data } = await forwardJson(
        `/api/rank/config/${encodeURIComponent(rankSlug)}`,
        { method: "POST", body: payload }
      );

      res.code(data.success ? 200 : 400).send(data);
    } catch (error) {
      res.code(500).send({ success: false, message: `${error}` });
    }
  });

  app.post(`${baseEndpoint}/user/lookup`, async function (req, res) {
    if (!ensureRankPermission(req, res)) return;

    const { username } = req.body || {};

    if (!username) {
      return res.code(400).send({
        success: false,
        message: "Username is required.",
      });
    }

    try {
      const { data } = await forwardJson(
        `/api/rank/user?username=${encodeURIComponent(username)}`,
        { method: "GET" }
      );

      res.code(data.success ? 200 : 400).send(data);
    } catch (error) {
      res.code(500).send({ success: false, message: `${error}` });
    }
  });

  app.post(`${baseEndpoint}/user/assign`, async function (req, res) {
    if (!ensureRankPermission(req, res)) return;

    const payload = req.body || {};

    if (!payload.username || !payload.rankSlug) {
      return res.code(400).send({
        success: false,
        message: "Username and rankSlug are required.",
      });
    }

    payload.actor = req.session?.user?.username || null;
    // From the session, overwriting anything the browser sent: the API uses
    // these to stop people promoting themselves above their own rank.
    payload.actorUserId = req.session?.user?.userId ?? null;
    payload.actorUuid = req.session?.user?.uuid ?? null;

    try {
      const { data } = await forwardJson(`/api/rank/user/assign`, {
        method: "POST",
        body: payload,
      });

      res.code(data.success ? 200 : 400).send(data);
    } catch (error) {
      res.code(500).send({ success: false, message: `${error}` });
    }
  });

  app.post(`${baseEndpoint}/user/remove`, async function (req, res) {
    if (!ensureRankPermission(req, res)) return;

    const payload = req.body || {};

    if (!payload.username || !payload.rankSlug) {
      return res.code(400).send({
        success: false,
        message: "Username and rankSlug are required.",
      });
    }

    try {
      const { data } = await forwardJson(`/api/rank/user/remove`, {
        method: "POST",
        body: payload,
      });

      res.code(data.success ? 200 : 400).send(data);
    } catch (error) {
      res.code(500).send({ success: false, message: `${error}` });
    }
  });

  app.post(`${baseEndpoint}/user/check-permission`, async function (req, res) {
    if (!ensureRankPermission(req, res)) return;

    const payload = req.body || {};

    if (!payload.username || !payload.permission) {
      return res.code(400).send({
        success: false,
        message: "Username and permission are required.",
      });
    }

    try {
      const { data } = await forwardJson(
        `/api/rank/user/permission/check`,
        { method: "POST", body: payload }
      );

      res.code(data.success ? 200 : 400).send(data);
    } catch (error) {
      res.code(500).send({ success: false, message: `${error}` });
    }
  });
}
