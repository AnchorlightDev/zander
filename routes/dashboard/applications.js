import {
  getGlobalImage,
  hasPermission,
  isFeatureWebRouteEnabled,
  setBannerCookie,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";

export default function dashboardApplicationsSiteRoute(
  app,
  fetch,
  config,
  db,
  features,
  lang
) {
  const parseApiResponse = async (response) => {
    try {
      const text = await response.text();
      if (!text) {
        return { success: false, message: "Empty response from API." };
      }
      return JSON.parse(text);
    } catch (error) {
      return { success: false, message: "Invalid response from API." };
    }
  };

  //
  // Applications
  //
  app.get("/dashboard/applications", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.applications, req, res, features))
      return;

    if (!await hasPermission("zander.web.application", req, res, features)) return;

    const [response, globalImage, announcementWeb] = await Promise.all([
      fetch(`${process.env.siteAddress}/api/application/get`, {
        headers: { "x-access-token": process.env.apiKey },
      }).catch(() => null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    const apiData = response ? await parseApiResponse(response) : { data: [] };

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/applications/application-list", {
        pageTitle: `Dashboard - Applications`,
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

  app.get("/dashboard/applications/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.applications, req, res, features))
      return;

    if (!await hasPermission("zander.web.application", req, res, features)) return;

    const [globalImage, announcementWeb] = await Promise.all([
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/applications/application-editor", {
        pageTitle: `Dashboard - Application Creator`,
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

  app.get("/dashboard/applications/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.applications, req, res, features))
      return;

    if (!await hasPermission("zander.web.application", req, res, features)) return;

    const applicationId = req.query.applicationId;
    const fetchURL = `${process.env.siteAddress}/api/application/get?id=${applicationId}`;

    const [response, globalImage, announcementWeb] = await Promise.all([
      fetch(fetchURL, {
        headers: { "x-access-token": process.env.apiKey },
      }).catch(() => null),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    const applicationApiData = response ? await parseApiResponse(response) : { success: false };

    if (!applicationApiData.success || !applicationApiData.data?.length) {
      setBannerCookie("danger", "Application not found.", res);
      return res.redirect("/dashboard/applications");
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/applications/application-editor", {
        pageTitle: `Dashboard - Application Editor`,
        config: config,
        applicationApiData: applicationApiData.data[0],
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
