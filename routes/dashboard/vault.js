import {
  getGlobalImage,
  hasPermission,
  isFeatureWebRouteEnabled,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";

export default function dashboardVaultSiteRoute(
  app,
  fetch,
  config,
  db,
  features,
  lang
) {
  const headers = { "x-access-token": process.env.apiKey };

  async function fetchJson(url, fallback = null) {
    try {
      const res = await fetch(url, { headers });
      return await res.json();
    } catch (error) {
      console.error(`[dashboard/vault] fetchJson failed for ${url}:`, error.message);
      return fallback;
    }
  }

  //
  // Vault
  //
  app.get("/dashboard/vault", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.vault, req, res, features))
      return;

    if (!await hasPermission("zander.web.vault", req, res, features)) return;

    const [apiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(`${process.env.siteAddress}/api/vault/get`, { data: [] }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/vault/vault-list", {
        pageTitle: `Dashboard - Vault`,
        config: config,
        apiData: apiData,
        features: features,
        req: req,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  app.get("/dashboard/vault/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.vault, req, res, features)) return;

    if (!await hasPermission("zander.web.vault", req, res, features)) return;

    const [globalImage, announcementWeb] = await Promise.all([
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/vault/vault-editor", {
        pageTitle: `Dashboard - Vault Creator`,
        config: config,
        type: "create",
        features: features,
        req: req,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });

  app.get("/dashboard/vault/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.vault, req, res, features)) return;

    if (!await hasPermission("zander.web.vault", req, res, features)) return;

    const vaultId = req.query.vaultId;

    const [vaultApiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(`${process.env.siteAddress}/api/vault/get?id=${vaultId}`, { data: [{}] }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/vault/vault-editor", {
        pageTitle: `Dashboard - Vault Editor`,
        config: config,
        vaultApiData: vaultApiData.data[0],
        type: "edit",
        features: features,
        req: req,
        globalImage,
        announcementWeb,
      })
    );
    return;
  });
}
