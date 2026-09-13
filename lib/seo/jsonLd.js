/**
 * schema.org / JSON-LD builders for SEO and GEO (Generative Engine
 * Optimization -- making pages legible and citable by AI answer engines like
 * Google AI Overviews, Perplexity, ChatGPT Search, Bing Copilot, Claude).
 *
 * Generative engines lean heavily on structured data and clean, answer-shaped
 * text to extract and attribute facts. These builders produce a single
 * `@graph` document per page: a stable Organization + WebSite node (referenced
 * by `@id` everywhere) plus page-specific nodes (WebPage, BreadcrumbList,
 * FAQPage, HowTo, ItemList, Article).
 *
 * Framework-free and pure so it can be unit tested and called from any route.
 */

function site(config) {
  return String(config?.siteConfiguration?.siteUrl || "").replace(/\/+$/, "");
}

function prune(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      delete obj[k];
    }
  }
  return obj;
}

/** Absolute URL for a path (or pass an already-absolute URL through). */
export function absoluteUrl(config, pathOrUrl) {
  const p = String(pathOrUrl || "");
  if (/^https?:\/\//i.test(p)) return p;
  return site(config) + (p.startsWith("/") ? p : "/" + p);
}

/** Canonical URL for the current request (query string stripped). */
export function canonicalUrl(config, req) {
  const path = (req && req.url ? String(req.url).split("?")[0] : "/") || "/";
  return site(config) + path;
}

export function orgId(config) {
  return `${site(config)}/#organization`;
}
export function websiteId(config) {
  return `${site(config)}/#website`;
}

export function organizationNode(config) {
  const sc = config?.siteConfiguration || {};
  const url = site(config);
  const sameAs = Object.values(sc.platforms || {}).filter(
    (v) => typeof v === "string" && /^https?:\/\//i.test(v)
  );
  return prune({
    "@type": "Organization",
    "@id": orgId(config),
    name: sc.siteName,
    url: url || undefined,
    description: sc.tagline || undefined,
    email: sc.email || undefined,
    logo: url ? { "@type": "ImageObject", url: `${url}/images/siteLogo.png` } : undefined,
    sameAs,
  });
}

export function websiteNode(config) {
  const sc = config?.siteConfiguration || {};
  const url = site(config);
  return prune({
    "@type": "WebSite",
    "@id": websiteId(config),
    name: sc.siteName,
    url: url || undefined,
    inLanguage: "en",
    publisher: { "@id": orgId(config) },
  });
}

/**
 * @param {object} config
 * @param {object} req                 fastify request (for the canonical URL)
 * @param {{ title?: string, description?: string, hasBreadcrumb?: boolean, primaryImage?: string }} opts
 */
export function webPageNode(config, req, opts = {}) {
  const url = canonicalUrl(config, req);
  return prune({
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: opts.title,
    description: opts.description,
    isPartOf: { "@id": websiteId(config) },
    about: { "@id": orgId(config) },
    breadcrumb: opts.hasBreadcrumb ? { "@id": `${url}#breadcrumb` } : undefined,
    primaryImageOfPage: opts.primaryImage ? absoluteUrl(config, opts.primaryImage) : undefined,
    inLanguage: "en",
  });
}

/**
 * @param {Array<{ name: string, url?: string }>} items  root -> current page
 */
export function breadcrumbNode(config, req, items) {
  const list = (items || []).filter((i) => i && i.name);
  if (list.length === 0) return null;
  const url = canonicalUrl(config, req);
  return {
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumb`,
    itemListElement: list.map((it, i) =>
      prune({
        "@type": "ListItem",
        position: i + 1,
        name: it.name,
        item: it.url ? absoluteUrl(config, it.url) : undefined,
      })
    ),
  };
}

/**
 * @param {Array<{ q: string, a: string }>} pairs
 */
export function faqNode(pairs) {
  const list = (pairs || []).filter((p) => p && p.q && p.a);
  if (list.length === 0) return null;
  return {
    "@type": "FAQPage",
    mainEntity: list.map((p) => ({
      "@type": "Question",
      name: String(p.q),
      acceptedAnswer: { "@type": "Answer", text: String(p.a) },
    })),
  };
}

/**
 * @param {{ name: string, description?: string, steps: Array<string | { name?: string, text: string }> }} opts
 */
export function howToNode(opts = {}) {
  const steps = (opts.steps || []).filter(Boolean);
  if (steps.length === 0) return null;
  return prune({
    "@type": "HowTo",
    name: opts.name,
    description: opts.description,
    step: steps.map((s, i) =>
      prune({
        "@type": "HowToStep",
        position: i + 1,
        name: typeof s === "string" ? `Step ${i + 1}` : s.name || `Step ${i + 1}`,
        text: typeof s === "string" ? s : s.text,
      })
    ),
  });
}

/**
 * @param {{ name: string, url?: string, description?: string,
 *           items: Array<{ name: string, url?: string, description?: string }> }} opts
 */
export function itemListNode(opts = {}) {
  const items = (opts.items || []).filter((i) => i && i.name);
  return prune({
    "@type": "ItemList",
    name: opts.name,
    url: opts.url,
    description: opts.description,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) =>
      prune({
        "@type": "ListItem",
        position: i + 1,
        name: it.name,
        url: it.url,
        description: it.description,
      })
    ),
  });
}

/**
 * @param {object} config
 * @param {object} article  { headline, description, url, datePublished?, dateModified?, image? }
 */
export function articleNode(config, article = {}) {
  return prune({
    "@type": "Article",
    headline: article.headline,
    description: article.description,
    url: article.url ? absoluteUrl(config, article.url) : undefined,
    datePublished: article.datePublished,
    dateModified: article.dateModified || article.datePublished,
    image: article.image ? absoluteUrl(config, article.image) : undefined,
    author: { "@id": orgId(config) },
    publisher: { "@id": orgId(config) },
    isPartOf: { "@id": websiteId(config) },
    inLanguage: "en",
  });
}

// U+2028 / U+2029 are valid in JSON strings but break inline <script> parsing;
// built via fromCharCode so no raw line-separator ever appears in this source.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** Serialise a value for safe embedding inside a <script> tag. */
export function scriptSafe(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEP)
    .join("\\u2028")
    .split(PARA_SEP)
    .join("\\u2029");
}

/**
 * Build the page's full JSON-LD graph and return a `<script>`-safe string.
 * The Organization + WebSite nodes are always included so every page carries
 * the site's canonical entity; extra `nodes` are page-specific.
 *
 * @param {object} config
 * @param {Array<object|null>} nodes
 * @returns {string}
 */
export function buildGraph(config, nodes = []) {
  const graph = [organizationNode(config), websiteNode(config), ...nodes].filter(Boolean);
  return scriptSafe({ "@context": "https://schema.org", "@graph": graph });
}

/** Default <meta name="robots"> value -- lets engines quote/preview freely. */
export const ROBOTS_INDEX =
  "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";
export const ROBOTS_NOINDEX = "noindex, nofollow";
