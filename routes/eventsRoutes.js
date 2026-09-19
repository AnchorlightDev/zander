/**
 * Public Events Routes
 * Provides the public-facing events listing and event detail pages.
 */

import { getGlobalImage, isFeatureWebRouteEnabled } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import { getUpcomingPublishedEvents, getAllPublishedEvents, getPublishedEventBySlug } from "../services/eventService.js";
import { enrichHostsWithAvatars } from "../lib/avatarHelpers.js";
import { renderDiscordTimestamps } from "../lib/discordTimestamps.js";
import { getRankMetaMap, getDonatorRankSlugs } from "../services/rankMetaService.js";
import {
  viewerRankSlugs,
  resolveEventAccess,
  redactLockedEvent,
  isSupporterEvent,
  buildLockCopy,
} from "../lib/eventAccess.js";

/**
 * Decide, for one event and one visitor, whether the detail must be redacted
 * and what the unlock panel should say.
 *
 * The listing and the detail page both need this, and they must agree: a card
 * that promises "Supporter event" must not open onto a page that says
 * something else.
 */
function describeAccess(event, viewerRanks, isStaff, rankMeta, donatorSlugs, isLoggedIn) {
  const access = resolveEventAccess(event, viewerRanks, { isStaff });
  if (!access.locked) return { access, lock: null, event };

  const supporter = isSupporterEvent(access.requiredRanks, donatorSlugs);
  return {
    access,
    lock: buildLockCopy(access.requiredRanks, rankMeta, supporter, isLoggedIn),
    event: redactLockedEvent(event),
  };
}

export default function eventsRoutes(app, config, features) {
  // ============================================================================
  // Events Listing Page
  // ============================================================================
  app.get("/events", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;

    try {
      const page = Math.max(parseInt(req.query.page || "1"), 1);
      const viewerRanks = viewerRankSlugs(req);
      const isStaff = Boolean(req.session?.user?.isStaff);
      const isLoggedIn = Boolean(req.session?.user);

      const [upcomingResult, allResult, rankMeta, donatorSlugs] = await Promise.all([
        getUpcomingPublishedEvents(6, viewerRanks, isStaff),
        getAllPublishedEvents(page, 12, viewerRanks, isStaff),
        getRankMetaMap(),
        getDonatorRankSlugs(),
      ]);

      // Redact before the template sees them — a locked card must not be one
      // stray <%= %> away from leaking the description it is selling.
      const decorate = (ev) => {
        const { lock, event } = describeAccess(ev, viewerRanks, isStaff, rankMeta, donatorSlugs, isLoggedIn);
        return { ...event, lock };
      };

      const upcomingEvents = upcomingResult.map(decorate);
      allResult.events = (allResult.events || []).map(decorate);

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/events/events-index", {
          pageTitle: "Events",
          pageDescription: `Upcoming and past community events for ${config.siteConfiguration.siteName}.`,
          config,
          req,
          features,
          upcomingEvents,
          allEvents: allResult,
          currentPage: page,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        })
      );
    } catch (err) {
      console.error("[Events] listing error:", err);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
          pageTitle: "Error",
          pageDescription: "Error loading events",
          config,
          req,
          error: err,
          features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        })
      );
    }
  });

  // ============================================================================
  // Event Detail Page
  // ============================================================================
  app.get("/events/:slug", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.events, req, res, features)) return;

    try {
      const viewerRanks = viewerRankSlugs(req);
      const isStaff = Boolean(req.session?.user?.isStaff);
      const isLoggedIn = Boolean(req.session?.user);

      const [rawEvent, rankMeta, donatorSlugs] = await Promise.all([
        getPublishedEventBySlug(req.params.slug, viewerRanks, isStaff),
        getRankMetaMap(),
        getDonatorRankSlugs(),
      ]);

      if (!rawEvent) {
        res.status(404);
        res.header("content-type", "text/html; charset=utf-8").send(
          await app.view("session/notFound", {
            pageTitle: "Event Not Found",
            config,
            req,
            features,
            globalImage: await getGlobalImage(),
            announcementWeb: await getWebAnnouncement(),
          })
        );
        return;
      }

      const { lock, event } = describeAccess(
        rawEvent, viewerRanks, isStaff, rankMeta, donatorSlugs, isLoggedIn
      );

      // Enrich hosts with avatar URLs (empty on a locked teaser)
      event.hosts = await enrichHostsWithAvatars(event.hosts || []);

      // Descriptions are authored once for both Discord and the web, so they
      // carry Discord's <t:...> timestamp tokens.  Substitute them at render
      // time only -- the stored copy keeps the raw tokens for Discord.
      event.description = renderDiscordTimestamps(event.description);

      // Build ICS/calendar data
      const startTs = Math.floor(new Date(event.startAt).getTime() / 1000);
      const endTs = Math.floor(new Date(event.endAt).getTime() / 1000);

      // Google Calendar link
      const gcalStart = new Date(event.startAt).toISOString().replace(/[-:]/g, "").replace(".000", "");
      const gcalEnd = new Date(event.endAt).toISOString().replace(/[-:]/g, "").replace(".000", "");
      const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(event.title)}&dates=${gcalStart}/${gcalEnd}&details=${encodeURIComponent((event.description || "").slice(0, 500))}&location=${encodeURIComponent(event.locationLabel || event.serverIp || "")}`;

      // Parse tags
      let tags = [];
      try {
        tags = Array.isArray(event.tags) ? event.tags : (event.tags ? JSON.parse(event.tags) : []);
      } catch { tags = []; }

      // Parse external links
      let externalLinks = [];
      try {
        externalLinks = Array.isArray(event.externalLinks) ? event.externalLinks : (event.externalLinks ? JSON.parse(event.externalLinks) : []);
      } catch { externalLinks = []; }

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/events/events-detail", {
          pageTitle: event.title,
          pageDescription: event.description
            ? event.description.replace(/<[^>]+>/g, "").slice(0, 200)
            : `${event.title} — Community event on ${config.siteConfiguration.siteName}`,
          config,
          req,
          features,
          event,
          tags,
          externalLinks,
          startTs,
          endTs,
          gcalUrl,
          lock,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        })
      );
    } catch (err) {
      console.error("[Events] detail error:", err);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
          pageTitle: "Error",
          pageDescription: "Error loading event",
          config,
          req,
          error: err,
          features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        })
      );
    }
  });
}
