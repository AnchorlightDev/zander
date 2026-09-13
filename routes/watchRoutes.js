import { getGlobalImage, isLoggedIn } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import {
  getPublicLiveContent,
  getPublicVideoContent,
  getPublicVideoCount,
} from "../controllers/watchController.js";

export default function watchSiteRoutes(app, client, fetch, moment, config, db, features, lang) {
  //
  // Public /watch page
  //
  app.get("/watch", async function (req, res) {
    if (!features.watch) {
      return res.status(404).view("session/notFound", {
        pageTitle: "404 Not Found",
        config,
        req,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      });
    }

    try {
      const PAGE_SIZE = 12;
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const offset = (page - 1) * PAGE_SIZE;

      const [liveContent, videoContent, totalVideos] = await Promise.all([
        getPublicLiveContent(),
        getPublicVideoContent(PAGE_SIZE, offset),
        getPublicVideoCount(),
      ]);

      const totalPages = Math.ceil(totalVideos / PAGE_SIZE);
      const pagination = {
        currentPage: page,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      };

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/watch/watch", {
        pageTitle: "Watch",
        pageDescription: `Watch live streams and videos from ${config.siteConfiguration.siteName} community creators.`,
        config,
        req,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
        liveContent,
        videoContent,
        pagination,
        moment,
      }));
      return;
    } catch (error) {
      console.error("[WATCH] Failed to load watch page", error);
      return res.status(500).view("session/error", {
        pageTitle: "Server Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      });
    }
  });

  //
  // JSON API: live content
  //
  app.get("/api/watch/live", async function (req, res) {
    try {
      const live = await getPublicLiveContent();
      return res.send({ success: true, data: live });
    } catch (error) {
      console.error("[WATCH] /api/watch/live error", error);
      return res.status(500).send({ success: false, message: "Failed to fetch live content." });
    }
  });

  //
  // JSON API: video content
  //
  app.get("/api/watch/videos", async function (req, res) {
    try {
      const videos = await getPublicVideoContent(20);
      return res.send({ success: true, data: videos });
    } catch (error) {
      console.error("[WATCH] /api/watch/videos error", error);
      return res.status(500).send({ success: false, message: "Failed to fetch video content." });
    }
  });

  //
  // JSON API: combined feed
  //
  app.get("/api/watch", async function (req, res) {
    try {
      const [live, videos] = await Promise.all([
        getPublicLiveContent(),
        getPublicVideoContent(20),
      ]);
      return res.send({ success: true, data: { live, videos } });
    } catch (error) {
      console.error("[WATCH] /api/watch error", error);
      return res.status(500).send({ success: false, message: "Failed to fetch watch feed." });
    }
  });
}
