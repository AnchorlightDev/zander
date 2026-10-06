/**
 * routes/pagesRoutes.js
 *
 * Public Resources and Contact pages.
 *
 *   GET  /resources         Published community resources by category
 *                           (features.resources). Anyone can view.
 *   POST /resources/submit  Suggest a resource -- signed-in members only. It
 *                           goes to the staff vote in
 *                           services/resourceReviewService.js.
 *   GET  /contact           Contact form (features.contact). Sending it opens a
 *   POST /contact           support ticket -- services/contactTicketService.js.
 *   GET  /contact/ticket/:id/:token   A guest's private page for their ticket
 *   POST /contact/ticket/:id/:token   (read the conversation, reply). Works
 *                                     even if the form is later switched off,
 *                                     so links already emailed keep working.
 *
 * Staff-written pages such as /about are custom pages
 * (routes/customPageRoutes.js), not routes here.
 */

import { getGlobalImage, isFeatureWebRouteEnabled, setBannerCookie } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import { getPublishedByCategory, listCategories } from "../controllers/resourceController.js";
import { checkRateLimit } from "../lib/rateLimiter.mjs";
import { CONTACT_LIMITS, parseContactSubmission, parseGuestReply } from "../lib/publicPages.mjs";
import { getTicketMessages } from "../controllers/supportTicketController.js";
import { getGuestTicket, openContactTicket, replyAsGuest } from "../services/contactTicketService.js";
import { RESOURCE_LIMITS } from "../lib/resources.mjs";
import { submitResource } from "../services/resourceReviewService.js";

export default function pagesSiteRoutes(app, config, features) {
  async function render(res, view, data) {
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view(view, {
        config,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
        ...data,
      })
    );
  }

  //
  // Resources
  //
  app.get("/resources", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.resources, req, res, features)) return;

    let categories = null;
    let allCategories = [];
    try {
      [categories, allCategories] = await Promise.all([getPublishedByCategory(), listCategories()]);
    } catch (error) {
      console.error("[resources] Could not load resources:", error);
    }

    return render(res, "resources", {
      pageTitle: "Resources",
      pageDescription: `Helpful links, apps and tools shared by the ${config.siteConfiguration.siteName} community.`,
      req,
      categories,
      allCategories,
      limits: RESOURCE_LIMITS,
    });
  });

  app.post("/resources/submit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.resources, req, res, features)) return;

    const user = req.session?.user;
    if (!user?.userId) {
      setBannerCookie("warning", "Please sign in to suggest a resource.", res);
      return res.redirect("/login");
    }
    if (!checkRateLimit(req, res, { windowMs: 60 * 60 * 1000, max: 5 })) return;

    try {
      const result = await submitResource(
        req.body,
        { userId: user.userId, name: user.username, discordId: user.discordID || null },
        "web"
      );
      if (!result.ok) setBannerCookie("danger", `Not submitted. ${result.errors.join(" ")}`, res);
      else setBannerCookie("success", "Thanks! Your suggestion has been sent to staff for review.", res);
    } catch (error) {
      console.error("[resources] Web submission failed:", error);
      setBannerCookie("danger", "Your suggestion could not be sent. Please try again later.", res);
    }
    return res.redirect("/resources#suggest");
  });

  //
  // Contact
  //
  app.get("/contact", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.contact, req, res, features)) return;

    return render(res, "contact", {
      pageTitle: "Contact Us",
      pageDescription: `Get in touch with the ${config.siteConfiguration.siteName} team.`,
      req,
      limits: CONTACT_LIMITS,
    });
  });

  app.post("/contact", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.contact, req, res, features)) return;
    if (!checkRateLimit(req, res, { windowMs: 15 * 60 * 1000, max: 5 })) return;

    // Honeypot: a hidden field people never see. A bot that fills it gets
    // the same success response, so it learns nothing.
    if (String(req.body?.website ?? "").trim() !== "") {
      setBannerCookie("success", "Thanks — your message has been sent.", res);
      return res.redirect("/contact");
    }

    const user = req.session?.user || null;
    const parsed = parseContactSubmission(req.body, { signedIn: Boolean(user) });
    if (!parsed.ok) {
      setBannerCookie("danger", parsed.error, res);
      return res.redirect("/contact");
    }

    try {
      const { ticketId, guest } = await openContactTicket(parsed.value, user);
      if (guest) {
        setBannerCookie("success", `Thanks — your message has been sent (reference #${ticketId}). We've emailed you a link to follow the conversation.`, res);
        return res.redirect("/contact");
      }
      setBannerCookie("success", "Thanks — your message has been sent. You can follow it here.", res);
      return res.redirect(`/support/ticket/${ticketId}`);
    } catch (error) {
      console.error("[contact] Could not open a ticket:", error);
      setBannerCookie("danger", "Your message could not be sent. Please try again later.", res);
      return res.redirect("/contact");
    }
  });

  //
  // A guest's private ticket page (link from their emails)
  //
  async function guestTicketOr404(req, res) {
    const ticket = await getGuestTicket(req.params.id, req.params.token).catch(() => null);
    if (!ticket) {
      res.callNotFound();
      return null;
    }
    // A secret is in the URL: keep it out of search engines and Referer headers.
    res.header("x-robots-tag", "noindex, nofollow").header("referrer-policy", "no-referrer");
    return ticket;
  }

  app.get("/contact/ticket/:id/:token", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 30 })) return;
    const ticket = await guestTicketOr404(req, res);
    if (!ticket) return;

    const messages = await getTicketMessages(ticket.ticketId, false);
    return render(res, "contactTicket", {
      pageTitle: `Your message #${ticket.ticketId}`,
      pageDescription: "Your conversation with the team.",
      req,
      ticket,
      messages,
      limits: CONTACT_LIMITS,
    });
  });

  app.post("/contact/ticket/:id/:token", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60 * 1000, max: 10 })) return;
    const ticket = await guestTicketOr404(req, res);
    if (!ticket) return;

    const back = `/contact/ticket/${ticket.ticketId}/${encodeURIComponent(req.params.token)}`;
    const parsed = parseGuestReply(req.body);
    if (!parsed.ok) {
      setBannerCookie("danger", parsed.error, res);
      return res.redirect(back);
    }

    try {
      const result = await replyAsGuest(ticket, parsed.value);
      setBannerCookie(result.ok ? "success" : "warning", result.ok ? "Reply sent. We'll email you when the team answers." : result.error, res);
    } catch (error) {
      console.error(`[contact] Guest reply to ticket #${ticket.ticketId} failed:`, error);
      setBannerCookie("danger", "Your reply could not be sent. Please try again later.", res);
    }
    return res.redirect(back);
  });
}
