import {
  getGlobalImage,
  hasPermission,
  isFeatureWebRouteEnabled,
  internalApiHeaders,
  setBannerCookie,
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
  const headers = internalApiHeaders();

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

    // Without an id the API lists every item, and the editor would open (and
    // save over) whichever came first.
    const vaultId = String(req.query.vaultId ?? "").trim();
    if (!/^\d+$/.test(vaultId)) {
      setBannerCookie("danger", "Vault item not found.", res);
      return res.redirect("/dashboard/vault");
    }

    const [vaultApiData, globalImage, announcementWeb] = await Promise.all([
      fetchJson(`${process.env.siteAddress}/api/vault/get?id=${encodeURIComponent(vaultId)}`, null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    const vaultItem = vaultApiData?.success && Array.isArray(vaultApiData.data) ? vaultApiData.data[0] : null;
    if (!vaultItem) {
      setBannerCookie("danger", "Vault item not found.", res);
      return res.redirect("/dashboard/vault");
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/vault/vault-editor", {
        pageTitle: `Dashboard - Vault Editor`,
        config: config,
        vaultApiData: vaultItem,
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
