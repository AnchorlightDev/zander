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
 *   GET  /contact           Contact form (features.contact), posted to the
 *   POST /contact           contact webhook.
 *
 * Staff-written pages such as /about are custom pages
 * (routes/customPageRoutes.js), not routes here.
 */

import { MessageBuilder, Webhook } from "discord-webhook-node";
import { Colors } from "discord.js";
import { getGlobalImage, isFeatureWebRouteEnabled, setBannerCookie } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import { getPublishedByCategory, listCategories } from "../controllers/resourceController.js";
import { checkRateLimit } from "../lib/rateLimiter.mjs";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";
import { CONTACT_LIMITS, parseContactSubmission } from "../lib/publicPages.mjs";
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

    const parsed = parseContactSubmission(req.body);
    if (!parsed.ok) {
      setBannerCookie("danger", parsed.error, res);
      return res.redirect("/contact");
    }

    const webhookUrl = config.discord?.webhooks?.contact;
    if (!webhookUrl) {
      console.warn("[contact] Contact webhook is not set (Settings → Pages & Resources); message not delivered.");
      setBannerCookie("danger", "The contact form is not available right now. Please try again later.", res);
      return res.redirect("/contact");
    }

    const { name, email, message } = parsed.value;
    const embed = new MessageBuilder()
      .setTitle("New contact form message")
      .addField("Name / username", name, false)
      .addField("Email", email, false)
      .addField("Message", message, false)
      .setColor(Colors.Blue)
      .setTimestamp();

    const sent = await sendWebhookMessage(new Webhook(webhookUrl), embed, { context: "contact" });
    if (!sent) {
      setBannerCookie("danger", "Your message could not be sent. Please try again later.", res);
      return res.redirect("/contact");
    }

    setBannerCookie("success", "Thanks — your message has been sent.", res);
    return res.redirect("/contact");
  });
}
