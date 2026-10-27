/**
 * lib/customPages.mjs
 *
 * Validation for staff-written custom pages (controllers/customPageController.js,
 * routes/dashboard/pages.js). No DB imports, so it is unit-testable.
 */

export const PAGE_STATUSES = ["draft", "published"];

export const PAGE_LIMITS = { slug: 100, title: 150, metaDescription: 300, content: 500_000 };

/** Lowercase letters, digits and single hyphens, e.g. "about" or "our-team". */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Top-level paths a page can never take, on top of whatever routes the app
 * registers (checked at save time with app.hasRoute). These are served by
 * plugins, static assets or prefixes rather than a single GET route.
 */
export const RESERVED_SLUGS = new Set([
  "admin", "api", "assets", "audio", "css", "dashboard", "images", "js",
  "login", "logout", "manifest.webmanifest", "redirect", "register", "scss",
  "sitemap.xml", "robots.txt", "llms.txt", "sw.js", "vendors", "videos",
]);

/** "Our Team!" → "our-team". */
export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PAGE_LIMITS.slug)
    .replace(/-+$/g, "");
}

/** The slug a request path would map to, or null when it is not a page path. */
export function slugFromPath(path) {
  const match = /^\/([a-z0-9-]{1,100})\/?$/.exec(String(path ?? "").split("?")[0]);
  return match && SLUG_PATTERN.test(match[1]) ? match[1] : null;
}

/**
 * Validate a page form.
 *
 * @param {object} body             The submitted form.
 * @param {(slug: string) => boolean} isTaken  True when another route already owns the slug.
 * @returns {{ ok: true, value: { slug, title, content, metaDescription, status } } | { ok: false, errors: string[] }}
 */
export function parsePageForm(body, isTaken = () => false) {
  const errors = [];
  const title = String(body?.title ?? "").trim();
  const slug = String(body?.slug ?? "").trim().toLowerCase() || slugify(title);
  const content = String(body?.content ?? "");
  const metaDescription = String(body?.metaDescription ?? "").trim();
  const status = PAGE_STATUSES.includes(body?.status) ? body.status : "draft";

  if (!title) errors.push("A title is required.");
  else if (title.length > PAGE_LIMITS.title) errors.push(`The title must be ${PAGE_LIMITS.title} characters or fewer.`);

  if (!slug) errors.push("A URL slug is required.");
  else if (slug.length > PAGE_LIMITS.slug || !SLUG_PATTERN.test(slug)) {
    errors.push("The URL slug may only use lowercase letters, numbers and single hyphens.");
  } else if (RESERVED_SLUGS.has(slug) || isTaken(slug)) {
    errors.push(`/${slug} is already used by another part of the site. Choose a different slug.`);
  }

  if (content.length > PAGE_LIMITS.content) errors.push("The page content is too long.");
  if (metaDescription.length > PAGE_LIMITS.metaDescription) {
    errors.push(`The search description must be ${PAGE_LIMITS.metaDescription} characters or fewer.`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: { slug, title, content, metaDescription: metaDescription || null, status } };
}
