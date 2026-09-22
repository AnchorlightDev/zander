import { createRequire } from "module";
const require = createRequire(import.meta.url);

import {
  getPopupAnnouncements,
  getWebAnnouncement,
} from "../controllers/announcementController.js";
import { isFeatureWebRouteEnabled, getGlobalImage, getJumboVideo, hasPermission, isLoggedIn, internalApiHeaders} from "../api/common.js";
import { getTicketsAccessibleByUser } from "../controllers/supportTicketController.js";
import { getStaffPageData } from "../controllers/staffController.js";
import {
  getDiscordPunishmentsForProfile,
} from "../controllers/discordPunishmentController.js";
import { UserGetter } from "../controllers/userController.js";

import dashboardSiteRoutes from "./dashboard/index.js";
import sessionRoutes from "./sessionRoutes.js";
import policySiteRoutes from "./policyRoutes.js";
import redirectSiteRoutes from "./redirectRoutes.js";
import profileSiteRoutes from "./profileRoutes.js";
import forumSiteRoutes from "./forumRoutes.js";
import supportRoutes from "./support.js";
import notificationRoutes from "./notificationRoutes.js";
import watchSiteRoutes from "./watchRoutes.js";
import sitemapRoutes from "./sitemapRoute.js";
import eventsSiteRoutes from "./eventsRoutes.js";
import financeRoutes from "./financeRoutes.js";
import webstoreSiteRoutes from "./webstoreRoutes.js";
import formSiteRoutes from "./formRoutes.js";
import bedrockSiteRoutes from "./bedrockRoutes.js";
import { getRankCatalogForPublicPage } from "../controllers/rankCatalogController.js";
import {
  buildGraph,
  webPageNode,
  breadcrumbNode,
  faqNode,
  howToNode,
  itemListNode,
} from "../lib/seo/jsonLd.js";
import { rankCatalogSchema } from "../lib/seo/rankSchema.js";

export default function applicationSiteRoutes(
  app,
  client,
  fetch,
  moment,
  config,
  db,
  features,
  lang
) {
  dashboardSiteRoutes(app, client, fetch, moment, config, db, features, lang);
  sessionRoutes(app, client, fetch, moment, config, db, features, lang);
  profileSiteRoutes(app, client, fetch, moment, config, db, features, lang);
  forumSiteRoutes(app, client, fetch, moment, config, db, features, lang);
  policySiteRoutes(app, config, features);
  redirectSiteRoutes(app, config, features);
  supportRoutes(app, client, fetch, moment, config, db, features, lang);
  notificationRoutes(app, config, features);
  watchSiteRoutes(app, client, fetch, moment, config, db, features, lang);
  sitemapRoutes(app, config, features);
  eventsSiteRoutes(app, config, features);
  financeRoutes(app, config, features);
  webstoreSiteRoutes(app, config, features);
  formSiteRoutes(app, config, features);
  bedrockSiteRoutes(app, config, features, lang);

  // Summernote editor fetches /emojis to populate its emoji picker.
  // Return an empty map so it silently falls back to the GitHub emoji list
  // rather than logging 404 errors in the server log.
  app.get("/emojis", async function (_req, res) {
    return res.send({});
  });

  app.get("/", async function (req, res) {
    let statApiData = null;
    try {
      const fetchURL = `${process.env.siteAddress}/api/web/statistics`;
      const response = await fetch(fetchURL, {
        headers: internalApiHeaders(),
      });
      const json = await response.json();
      if (json?.data) statApiData = json;
    } catch (_) {
      // stats unavailable — page still renders without counters
    }

    const siteName = config.siteConfiguration.siteName;
    const tagline = config.siteConfiguration.tagline || "";
    const discordUrl = config.siteConfiguration.platforms?.discord;
    // Organization + WebSite are added by buildGraph; add the page + an
    // answer-shaped FAQ so generative engines can field the common
    // "what is / how do I join / is it free" questions from the homepage.
    const pageJsonLd = buildGraph(config, [
      webPageNode(config, req, {
        title: siteName,
        description: `Welcome to ${siteName} — ${tagline}`,
      }),
      faqNode([
        {
          q: `What is ${siteName}?`,
          a: `${siteName} is a Christ-centred Minecraft community${tagline ? ` — ${tagline}` : ""}. It runs a Minecraft server plus a Discord, community forums and regular events.`,
        },
        {
          q: `How do I join ${siteName}?`,
          a: `Get the Java or Bedrock server address from ${config.siteConfiguration.siteUrl}/play and connect in Minecraft${discordUrl ? `, then join the community Discord at ${discordUrl}` : ""}.`,
        },
        {
          q: `Is ${siteName} free to play?`,
          a: `Yes — the server is free to join. Optional cosmetic and convenience ranks are available at ${config.siteConfiguration.siteUrl}/ranks.`,
        },
      ]),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/index/index", {
      pageTitle: `${config.siteConfiguration.siteName}`,
      pageDescription: `Welcome to ${config.siteConfiguration.siteName} — ${config.siteConfiguration.tagline}`,
      pageJsonLd,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      jumboVideo: getJumboVideo(),
      statApiData: statApiData,
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.get("/announcement/popup", async function (req, res) {
    if (!features.announcements) {
      return res.send({
        success: false,
        message: "Announcements disabled.",
      });
    }

    const popupAnnouncements = await getPopupAnnouncements();

    return res.send({
      success: popupAnnouncements.length > 0,
      data: popupAnnouncements,
    });
  });

  //
  // Play
  //
  app.get("/play", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;

    const fetchURL = `${process.env.siteAddress}/api/server/get?type=EXTERNAL`;
    const response = await fetch(fetchURL, {
      headers: internalApiHeaders(),
    });
    const apiData = await response.json();

    const siteName = config.siteConfiguration.siteName;
    const siteUrl = config.siteConfiguration.siteUrl;
    const discordUrl = config.siteConfiguration.platforms?.discord;
    const servers =
      apiData?.success !== false && Array.isArray(apiData?.data)
        ? apiData.data
            .map((s) => ({ name: s.displayName, address: s.serverConnectionAddress }))
            .filter((s) => s.address)
        : [];
    const addrSentence = servers.length
      ? servers.map((s) => `${s.name} — ${s.address}`).join("; ")
      : `See ${siteUrl}/play for the current server address.`;
    const playDescription = `Connect and play on ${siteName}. Get the Java and Bedrock server addresses and step-by-step instructions to join.`;

    const pageJsonLd = buildGraph(config, [
      webPageNode(config, req, { title: "Play", description: playDescription, hasBreadcrumb: true }),
      breadcrumbNode(config, req, [{ name: "Home", url: "/" }, { name: "Play" }]),
      howToNode({
        name: `How to join ${siteName} in Minecraft`,
        description: `Steps to connect to the ${siteName} Minecraft server.`,
        steps: [
          "Open Minecraft (Java or Bedrock Edition) and choose Multiplayer, then Add Server.",
          `Enter the server address — ${addrSentence}.`,
          "Save the server, then select it and click Join / Play.",
          discordUrl ? `Optional: join the community Discord at ${discordUrl} for help and announcements.` : null,
        ].filter(Boolean),
      }),
      faqNode([
        { q: `What is the ${siteName} server address?`, a: addrSentence },
        {
          q: `Can I join ${siteName} on Bedrock Edition (console, mobile, Windows)?`,
          a:
            servers.length > 1
              ? `Yes. Use the correct address for your edition — ${addrSentence}.`
              : `Check ${siteUrl}/play for the current Java and Bedrock addresses.`,
        },
        {
          q: `Do I need an account or to pay to join ${siteName}?`,
          a: `You need a legitimate Minecraft account. Joining the server is free; optional ranks are available at ${siteUrl}/ranks.`,
        },
      ]),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/play/play", {
      pageTitle: `Play`,
      pageDescription: playDescription,
      pageJsonLd,
      servers,
      config: config,
      req: req,
      apiData: apiData,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  //
  // Apply
  //
  app.get("/apply", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.applications, req, res, features)) return;

    const fetchURL = `${process.env.siteAddress}/api/application/get`;
    const response = await fetch(fetchURL, {
      headers: internalApiHeaders(),
    });
    const apiData = await response.json();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("apply", {
      pageTitle: `Apply`,
      pageDescription: `Apply to join the ${config.siteConfiguration.siteName} team. View open positions and submit your application.`,
      config: config,
      req: req,
      apiData: apiData,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  //
  // Ranks
  //
  app.get("/ranks", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.ranks, req, res, features)) return;

    let rankCategories = [];
    let ranksError = null;
    try {
      rankCategories = await getRankCatalogForPublicPage();
    } catch (err) {
      console.error("[ranks] Failed to load rank catalog:", err.message);
      ranksError = "Rank information is temporarily unavailable. Please try again shortly.";
    }

    const rankPageDescription = `Explore the ranks available on ${config.siteConfiguration.siteName} and find out what perks and privileges each one offers.`;
    const { itemList: rankItemList, faq: rankFaq } = rankCatalogSchema(config, rankCategories);
    const pageJsonLd = buildGraph(config, [
      webPageNode(config, req, { title: "Ranks", description: rankPageDescription, hasBreadcrumb: true }),
      breadcrumbNode(config, req, [{ name: "Home", url: "/" }, { name: "Ranks" }]),
      rankItemList,
      faqNode(rankFaq),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("ranks", {
        pageTitle: `Ranks`,
        pageDescription: rankPageDescription,
        pageJsonLd,
        rankFaq,
        config: config,
        req: req,
        rankCategories,
        ranksError,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
    return;
  });

  //
  // Staff
  //
  app.get("/staff", async function (req, res) {
    try {
      const staffData = await getStaffPageData();

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("staff", {
        pageTitle: `Staff`,
        pageDescription: `Meet the ${config.siteConfiguration.siteName} staff team — the dedicated volunteers who keep our community safe and welcoming.`,
        config: config,
        req: req,
        staffData: staffData,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    } catch (err) {
      console.error("Error loading staff page:", err);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error loading staff page",
        config: config,
        req: req,
        error: err,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  //
  // Report
  //
  app.get("/report", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.report, req, res, features)) {
      return;
    }

    if (!req.session.user) {
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notLoggedIn", {
        pageTitle: `Access Restricted`,
        config: config,
        req: req,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("report", {
      pageTitle: `Report`,
      pageDescription: `Report a player or incident on ${config.siteConfiguration.siteName}. Our staff team will review your report promptly.`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  //
  // Punishment Appeals
  //
  app.get("/appeal", async function (req, res) {
    try {
      const isLoggedIn = Boolean(req.session.user);
      let appealPunishmentsApiData = { success: true, data: [] };
      let appealTicketsByKey = {};

      let discordPunishmentsData = [];

      if (isLoggedIn) {
        const fetchPunishmentsURL = `${process.env.siteAddress}/api/user/punishments?username=${encodeURIComponent(
          req.session.user.username
        )}`;
        const punishmentsResponse = await fetch(fetchPunishmentsURL, {
          headers: internalApiHeaders(),
        });
        appealPunishmentsApiData = await punishmentsResponse.json();

        // Also fetch Discord punishments
        try {
          const userGetter = new UserGetter();
          const userRecord = await userGetter.byUsername(req.session.user.username);
          if (userRecord) {
            discordPunishmentsData = await getDiscordPunishmentsForProfile({
              discordUserId: userRecord.discordId || null,
              playerId: userRecord.userId || null,
            });
          }
        } catch (err) {
          console.error("[APPEAL] Failed to fetch Discord punishments:", err);
        }

        const userRankSlugs =
          req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
        const tickets = await getTicketsAccessibleByUser(
          req.session.user.userId,
          userRankSlugs
        );
        appealTicketsByKey = (tickets || []).reduce((acc, ticket) => {
          if (ticket.status === "closed") {
            return acc;
          }
          const match = String(ticket.title || "").match(/Appeal #([^\s]+)/);
          if (match && match[1]) {
            acc[match[1]] = ticket.ticketId;
          }
          return acc;
        }, {});
      }

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/appeal/appeal", {
        pageTitle: "Punishment Appeal",
        pageDescription: `Appeal a punishment on ${config.siteConfiguration.siteName}. Submit your case for staff review.`,
        config: config,
        req: req,
        features: features,
        appealPunishmentsApiData: appealPunishmentsApiData,
        discordPunishmentsData: discordPunishmentsData,
        appealTicketsByKey: appealTicketsByKey,
        moment: moment,
        isLoggedIn: isLoggedIn,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config: config,
        req: req,
        error: error,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.get("/appeal/start", async function (req, res) {
    try {
      if (!req.session.user) {
        const returnTo = encodeURIComponent(req.url);
        return res.redirect(`/login?returnTo=${returnTo}`);
      }

      const punishmentIndex = Number.parseInt(req.query.punishmentIndex, 10);
      if (!Number.isInteger(punishmentIndex) || punishmentIndex < 0) {
        return res.redirect("/appeal");
      }

      const fetchPunishmentsURL = `${process.env.siteAddress}/api/user/punishments?username=${encodeURIComponent(
        req.session.user.username
      )}`;
      const punishmentsResponse = await fetch(fetchPunishmentsURL, {
        headers: internalApiHeaders(),
      });
      const appealPunishmentsApiData = await punishmentsResponse.json();
      const punishments = Array.isArray(appealPunishmentsApiData.data)
        ? appealPunishmentsApiData.data
        : [];
      const punishment = punishments[punishmentIndex];

      if (!punishment) {
        return res.redirect("/appeal");
      }

      const fallbackKey = moment(punishment.dateStart).isValid()
        ? `${punishment.type || "unknown"}-${moment(punishment.dateStart).valueOf()}`
        : String(punishmentIndex);
      const punishmentKey = String(
        punishment.id || punishment.punishmentId || punishment.punishment_id || fallbackKey
      );
      const userRankSlugs =
        req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const tickets = await getTicketsAccessibleByUser(
        req.session.user.userId,
        userRankSlugs
      );
      const existingTicket = (tickets || []).find((ticket) => {
        if (ticket.status === "closed") return false;
        return String(ticket.title || "").includes(`Appeal #${punishmentKey}`);
      });
      if (existingTicket) {
        return res.redirect(`/support/ticket/${existingTicket.ticketId}`);
      }

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/appeal/appeal-form", {
        pageTitle: "Punishment Appeal",
        config: config,
        req: req,
        features: features,
        punishmentIndex: punishmentIndex,
        punishmentKey: punishmentKey,
        punishment: punishment,
        moment: moment,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config: config,
        req: req,
        error: error,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  //
  // Shop Directory
  // 
  app.get("/shopdirectory", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.shopdirectory, req, res, features)) return;

    if (!isLoggedIn(req)) {
      return res.redirect("/login?returnTo=/shopdirectory");
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("shopdirectory", {
      pageTitle: `Shop Directory`,
      pageDescription: `Browse the ${config.siteConfiguration.siteName} player shop directory. Find items, prices, and in-game stores.`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  })

  // Proxy endpoint for client-side shop search (avoids exposing API key)
  app.get("/shopdirectory/search", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.shopdirectory, req, res, features)) return;

    if (!isLoggedIn(req)) {
      return res.status(401).send({ success: false, message: "You must be logged in." });
    }

    const material = req.query.material || "";
    const page = req.query.page || "1";
    const shopFetchURL = `${process.env.siteAddress}/api/shop/get?material=${encodeURIComponent(material)}&page=${encodeURIComponent(page)}`;

    try {
      const shopResponse = await fetch(shopFetchURL, {
        headers: internalApiHeaders(),
      });

      if (!shopResponse.ok) {
        console.error("Shop search proxy: API returned status", shopResponse.status);
        return res.send({
          success: false,
          message: "Shop service is temporarily unavailable. Please try again.",
        });
      }

      const responseText = await shopResponse.text();
      if (!responseText) {
        return res.send({
          success: false,
          message: "Shop service returned an empty response. Please try again.",
        });
      }

      const shopApiData = JSON.parse(responseText);
      return res.send(shopApiData);
    } catch (err) {
      console.error("Shop search proxy error:", err);
      return res.send({
        success: false,
        message: "Failed to fetch shop data. Please try again.",
      });
    }
  })
  
  //
  // Vault
  //
  app.get("/vault", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.vault, req, res, features)) return;

    const fetchURL = `${process.env.siteAddress}/api/vault/get`;
    const response = await fetch(fetchURL, {
      headers: internalApiHeaders(),
    });
    const apiData = await response.json();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("vault", {
      pageTitle: `Vault`,
      pageDescription: `Access the ${config.siteConfiguration.siteName} vault to manage your stored in-game items.`,
      config: config,
      req: req,
      apiData: apiData,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  //
  // Punishments
  //
  app.get("/punishments", async function (req, res) {
    const permissionBoolean = await hasPermission(
      "zander.web.punishment.view",
      req,
      res,
      features
    );

    if (!permissionBoolean) return;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

    const fetchURL = `${process.env.siteAddress}/api/punishments/get?page=${page}&limit=${limit}`;
    const response = await fetch(fetchURL, {
      headers: internalApiHeaders(),
    });
    const apiData = await response.json();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/punishments/punishments", {
      pageTitle: `Punishments`,
      pageDescription: `View the public punishment log for ${config.siteConfiguration.siteName}.`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      apiData: apiData,
      moment: moment,
    }));
    return;
  });
}
