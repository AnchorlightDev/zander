/**
 * lib/navigation/menus.mjs
 *
 * The site's editable menus: what a menu item is, the built-in defaults, how
 * a saved menu is validated, and how it is resolved for one visitor.
 * No DB imports, so it is unit-testable. Storage and caching are in
 * controllers/navigationController.js; the editor is /dashboard/menus.
 *
 * Locations
 * ---------
 *   topbar  The thin bar above the header. Flat; items may have an icon.
 *   header  The main navigation. A heading with children is a dropdown.
 *   footer  Columns: every top-level item is a heading, its children links.
 *
 * Item shape (as stored)
 * ----------------------
 *   { type, label, url?, pageId?, edition?, icon?, newTab?, visibility?, feature?, children? }
 *
 *   type        link | page | heading | server
 *   url         link only: "/path", "https://…", "http://…" or "mailto:…"
 *   pageId      page only: a custom page; hidden while it is missing or a draft
 *   edition     server only: java | bedrock -- shows that address from the servers dashboard
 *   icon        Font Awesome classes, e.g. "fa-brands fa-discord"
 *   visibility  everyone (default) | guests | members
 *   feature     a module switch (dot path); the item hides while it is off
 */

export const MENU_LOCATIONS = {
  topbar: {
    label: "Top bar",
    description: "The thin bar above the main navigation.",
    types: ["link", "page", "server"],
    maxDepth: 1,
  },
  header: {
    label: "Header",
    description: "The main navigation. Put links under a heading to make a dropdown.",
    types: ["link", "page", "heading"],
    maxDepth: 2,
  },
  footer: {
    label: "Footer",
    description: "Footer columns. Each top-level heading is a column; links go under it.",
    types: ["link", "page", "heading"],
    maxDepth: 2,
  },
};

export const ITEM_TYPES = ["link", "page", "heading", "server"];
export const VISIBILITIES = ["everyone", "guests", "members"];
export const MAX_ITEMS_PER_MENU = 60;

const LABEL_MAX = 60;
const URL_MAX = 500;
const ICON_PATTERN = /^(fa-[a-z0-9-]+)( fa-[a-z0-9-]+){0,3}$/;

/**
 * Site pages staff can add to a menu with one click. A link added from here
 * carries the page's module switch, so it hides when the module is off.
 */
export const BUILTIN_LINKS = [
  { label: "Home", url: "/" },
  { label: "Play", url: "/play", feature: "server" },
  { label: "Bedrock", url: "/bedrock", feature: "bedrock" },
  { label: "Ranks", url: "/ranks", feature: "ranks" },
  { label: "Forums", url: "/forums", feature: "forums" },
  { label: "Events", url: "/events", feature: "events" },
  { label: "Apply", url: "/apply", feature: "applications" },
  { label: "Webstore", url: "/webstore", feature: "webstore" },
  { label: "Watch", url: "/watch", feature: "watch" },
  { label: "Vault", url: "/vault", feature: "vault" },
  { label: "Shop Directory", url: "/shopdirectory", feature: "shopdirectory" },
  { label: "Resources", url: "/resources", feature: "resources" },
  { label: "Staff", url: "/staff" },
  { label: "Finance", url: "/finance" },
  { label: "Rules", url: "/rules" },
  { label: "Report a Player", url: "/report", feature: "report" },
  { label: "Support", url: "/support", feature: "support" },
  { label: "Appeal", url: "/appeal" },
  { label: "Punishments", url: "/punishments", feature: "discord.punishments" },
  { label: "Contact Us", url: "/contact", feature: "contact" },
  { label: "Knowledgebase", url: "/knowledgebase" },
  { label: "Terms Of Service", url: "/terms" },
  { label: "Privacy Policy", url: "/privacy" },
  { label: "Refund Policy", url: "/refund" },
];

const builtin = (url, label) => {
  const link = BUILTIN_LINKS.find((l) => l.url === url);
  return { type: "link", label: label || link.label, url, ...(link.feature ? { feature: link.feature } : {}) };
};
const heading = (label, children) => ({ type: "heading", label, children });

/**
 * The menus a site has before anyone edits them -- the same links the
 * templates used to hard-code. Built from config each time, so the top bar
 * follows the support email and Discord invite until it is customised.
 */
export function defaultMenus(config = {}) {
  const site = config.siteConfiguration || {};
  const topbar = [];
  if (site.email) topbar.push({ type: "link", label: site.email, url: `mailto:${site.email}`, icon: "fa-solid fa-envelope" });
  if (site.platforms?.discord) topbar.push({ type: "link", label: "Community Discord", url: site.platforms.discord, icon: "fa-brands fa-discord", newTab: true });
  topbar.push({ type: "server", label: "Java address", edition: "java", icon: "fa-solid fa-laptop" });
  topbar.push({ type: "server", label: "Bedrock address", edition: "bedrock", icon: "fa-solid fa-mobile-screen" });

  return {
    topbar,
    header: [
      builtin("/"),
      heading("Play", [builtin("/play"), builtin("/ranks")]),
      heading("Community", [builtin("/forums"), builtin("/events"), builtin("/apply")]),
      builtin("/webstore"),
      heading("Help", [builtin("/rules"), builtin("/report", "Report"), builtin("/support")]),
    ],
    footer: [
      heading("Quick Access", [
        builtin("/apply"),
        builtin("/knowledgebase"),
        builtin("/report"),
        builtin("/ranks"),
        builtin("/vault"),
        builtin("/shopdirectory"),
        builtin("/resources"),
        builtin("/contact"),
      ]),
      heading("Legal", [builtin("/rules"), builtin("/terms"), builtin("/privacy"), builtin("/refund")]),
    ],
  };
}

/** A link target staff may enter: site-relative path, http(s) or mailto. */
export function isAllowedUrl(value) {
  const url = String(value ?? "").trim();
  if (!url || url.length > URL_MAX) return false;
  if (url.startsWith("/")) return !url.startsWith("//") && !url.includes("\\");
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate a menu submitted from the editor.
 *
 * @param {string} location
 * @param {unknown} raw            The item tree (already JSON-parsed).
 * @param {{ featurePaths?: Iterable<string> }} [options]  Module switches an item may depend on.
 * @returns {{ ok: true, items: object[] } | { ok: false, errors: string[] }}
 */
export function parseMenu(location, raw, { featurePaths = [] } = {}) {
  const spec = MENU_LOCATIONS[location];
  if (!spec) return { ok: false, errors: ["Unknown menu."] };
  if (!Array.isArray(raw)) return { ok: false, errors: ["The menu could not be read. Reload the page and try again."] };

  const flags = new Set(featurePaths);
  const errors = [];
  let count = 0;

  const parseItem = (item, depth, where) => {
    count++;
    const type = item?.type;
    const label = String(item?.label ?? "").trim();
    const name = label ? `"${label}"` : where;

    if (!spec.types.includes(type)) {
      errors.push(`${name}: this kind of item cannot go in the ${spec.label.toLowerCase()}.`);
      return null;
    }
    if (type !== "server" && !label) errors.push(`${where}: a label is required.`);
    if (label.length > LABEL_MAX) errors.push(`${name}: labels must be ${LABEL_MAX} characters or fewer.`);

    const out = { type, label };

    if (type === "link") {
      const url = String(item.url ?? "").trim();
      if (!isAllowedUrl(url)) errors.push(`${name}: the link must start with /, https://, http:// or mailto:.`);
      out.url = url;
    } else if (type === "page") {
      const pageId = Number(item.pageId);
      if (!Number.isInteger(pageId) || pageId < 1) errors.push(`${name}: choose a page.`);
      out.pageId = pageId;
    } else if (type === "server") {
      if (!["java", "bedrock"].includes(item.edition)) errors.push(`${name}: choose Java or Bedrock.`);
      out.edition = item.edition;
    }

    const icon = String(item.icon ?? "").trim();
    if (icon) {
      if (!ICON_PATTERN.test(icon)) errors.push(`${name}: the icon must be Font Awesome classes, e.g. "fa-solid fa-star".`);
      out.icon = icon;
    }
    if (item.newTab === true || item.newTab === "true") out.newTab = true;

    const visibility = item.visibility || "everyone";
    if (!VISIBILITIES.includes(visibility)) errors.push(`${name}: unknown visibility.`);
    if (visibility !== "everyone") out.visibility = visibility;

    const feature = String(item.feature ?? "").trim();
    if (feature) {
      if (!flags.has(feature)) errors.push(`${name}: unknown module "${feature}".`);
      out.feature = feature;
    }

    const children = Array.isArray(item.children) ? item.children : [];
    if (children.length) {
      if (type !== "heading" || depth >= spec.maxDepth) {
        errors.push(`${name}: only a top-level heading can have items under it.`);
      } else {
        out.children = children.map((child, i) => parseItem(child, depth + 1, `Item ${i + 1} under ${name}`)).filter(Boolean);
      }
    }

    if (location === "footer" && depth === 1 && type !== "heading") {
      errors.push(`${name}: footer links must sit under a column heading.`);
    }
    if (location === "footer" && depth === 2 && type === "heading") {
      errors.push(`${name}: footer columns cannot be nested.`);
    }
    if (location === "header" && depth === 2 && type === "heading") {
      errors.push(`${name}: dropdowns cannot be nested.`);
    }

    return out;
  };

  const items = raw.map((item, i) => parseItem(item, 1, `Item ${i + 1}`)).filter(Boolean);
  if (count > MAX_ITEMS_PER_MENU) errors.push(`A menu can hold at most ${MAX_ITEMS_PER_MENU} items.`);

  return errors.length ? { ok: false, errors } : { ok: true, items };
}

const flagOn = (features, path) =>
  path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), features) === true;

/**
 * Resolve a stored menu for one visitor: drop what they should not see and
 * turn page/server items into plain links or text.
 *
 * @param {object[]} items
 * @param {object} ctx
 * @param {object}  ctx.features
 * @param {boolean} ctx.loggedIn
 * @param {Map<number, string>} ctx.pageSlugs  Published custom pages: pageId → slug.
 * @param {{ java?: string|null, bedrock?: string|null }} ctx.addresses
 * @param {string}  [ctx.currentPath]
 * @returns {Array<{ label, url, icon, newTab, isHeading, active, children }>}
 */
export function resolveMenu(items, { features = {}, loggedIn = false, pageSlugs = new Map(), addresses = {}, currentPath = "" } = {}) {
  const path = String(currentPath).split("?")[0];

  const resolveItem = (item) => {
    if (item.feature && !flagOn(features, item.feature)) return null;
    if (item.visibility === "guests" && loggedIn) return null;
    if (item.visibility === "members" && !loggedIn) return null;

    let url = null;
    let label = item.label;
    if (item.type === "link") url = item.url;
    else if (item.type === "page") {
      const slug = pageSlugs.get(item.pageId);
      if (!slug) return null;
      url = `/${slug}`;
    } else if (item.type === "server") {
      const address = addresses[item.edition];
      if (!address) return null;
      label = address;
    }

    const children = (item.children || []).map(resolveItem).filter(Boolean);
    // A heading is only worth showing with something under it.
    if (item.type === "heading" && !children.length) return null;

    return {
      label,
      url,
      icon: item.icon || null,
      newTab: Boolean(item.newTab),
      isHeading: item.type === "heading",
      active: Boolean(url && url.startsWith("/") && (url === "/" ? path === "/" : path === url || path.startsWith(`${url}/`))),
      children,
    };
  };

  return (items || []).map(resolveItem).filter(Boolean);
}
