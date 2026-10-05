/**
 * routes/customPageRoutes.js
 *
 * Serves staff-written pages at /<slug>.
 *
 * Called from the not-found handler in app.js rather than registered as a
 * `/:slug` route: find-my-way would rank a parametric route above
 * @fastify/static's wildcard and swallow root files like /favicon.ico, and a
 * page must never shadow a real route. So a page only answers a path nothing
 * else did.
 *
 * Drafts are visible to staff holding zander.web.pages, with a banner, so a
 * page can be previewed before it is published.
 */

import { getGlobalImage } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import { getPageBySlug } from "../controllers/customPageController.js";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { slugFromPath } from "../lib/customPages.mjs";
import { sanitizeForumHtml } from "../lib/htmlSanitize.js";

export const PAGES_PERMISSION = "zander.web.pages";

/**
 * Render the custom page for this request, if there is one.
 *
 * @returns {Promise<boolean>} true when a page was sent.
 */
export async function serveCustomPage(app, req, res, config, features) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const slug = slugFromPath(req.url);
  if (!slug) return false;

  let page;
  try {
    page = await getPageBySlug(slug);
  } catch (error) {
    console.error(`[customPages] Could not load /${slug}:`, error);
    return false;
  }
  if (!page) return false;

  const isPreview = page.status !== "published";
  if (isPreview && !hasPermission(req.session?.user?.permissions, PAGES_PERMISSION)) return false;

  res.status(200);
  if (isPreview) res.header("x-robots-tag", "noindex");
  res.header("content-type", "text/html; charset=utf-8").send(
    await app.view("customPage", {
      pageTitle: page.title,
      pageDescription: page.metaDescription || `${page.title} — ${config.siteConfiguration.siteName}`,
      config,
      req,
      features,
      page,
      pageHtml: sanitizeForumHtml(page.content),
      isPreview,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    })
  );
  return true;
}
