import {
  getCategoriesForUser,
  getRecentDiscussions,
} from "../controllers/forumController.js";
import { getAllPublishedEvents } from "../services/eventService.js";
import { resolveEventAccess } from "../lib/eventAccess.js";

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// AI answer-engine / crawler user-agents we explicitly welcome (GEO). Policy is
// "allow all" — listing them by name makes the stance auditable and easy to
// tune per-bot later without touching the generic `*` rule.
const AI_USER_AGENTS = [
  "GPTBot",            // OpenAI training crawler
  "OAI-SearchBot",     // OpenAI search index
  "ChatGPT-User",      // ChatGPT live browsing / plugins
  "PerplexityBot",     // Perplexity index
  "Perplexity-User",   // Perplexity live fetch
  "ClaudeBot",         // Anthropic crawler
  "Claude-SearchBot",  // Anthropic search index
  "Claude-User",       // Claude live fetch
  "Anthropic-AI",      // legacy Anthropic UA
  "Google-Extended",   // Gemini / AI Overviews training opt-in
  "Applebot-Extended", // Apple Intelligence training opt-in
  "Bingbot",           // Bing + Copilot
  "DuckAssistBot",     // DuckDuckGo AI
  "Amazonbot",         // Amazon / Alexa
  "Bytespider",        // ByteDance / Doubao
  "CCBot",             // Common Crawl (feeds many models)
  "cohere-ai",
  "Meta-ExternalAgent", // Meta AI
  "Timpibot",
  "YouBot",
];

/*
    Paths crawlers are told not to fetch.

    Deliberately short.  robots.txt controls *crawling*, not *indexing* — a
    blocked URL that is linked from elsewhere on the site still gets indexed,
    as a bare URL with no title or snippet.  That is the "Indexed, though
    blocked by robots.txt" state in Search Console.

    Worse, blocking a page hides its <meta name="robots" content="noindex">,
    because the crawler never fetches the page to read it.  So a page that is
    both Disallow-ed here and marked noindex will never be dropped.

    The rule therefore is: anything that renders HTML and should stay out of
    the index is NOT listed here — it is crawlable and declares `noindex`
    itself (`pageRobots` in views/modules/header.ejs, and the hardcoded tag in
    views/admin/_head.ejs for the dashboard).  Only surfaces with nothing to
    index at all belong below.
*/
export const DISALLOW = [
  // JSON only — no markup, so no meta tag is possible, and nothing links to it.
  "/api/",
  // Side-effecting action rather than a page.
  "/logout",
];

/**
 * The fixed public pages, filtered to those whose feature is on.
 *
 * Exported and pure so the invariant that matters -- a disabled page never
 * appears in the sitemap -- can be tested directly.
 *
 * The entries with no flag are pages that are served unconditionally by their
 * routes. `/finance` is one of them: features.finance exists but
 * routes/financeRoutes.js does not gate on it, and the sitemap follows what is
 * actually served rather than what a flag suggests.
 */
export function staticSitemapPages(features = {}) {
  return [
    { url: "/", priority: "1.0", changefreq: "daily" },
    features.server && { url: "/play", priority: "0.9", changefreq: "weekly" },
    features.bedrock && { url: "/bedrock", priority: "0.8", changefreq: "monthly" },
    features.ranks && { url: "/ranks", priority: "0.8", changefreq: "weekly" },
    // The map archive: years of worlds with seeds, dates and downloads. Rare
    // content, and it was missing from here entirely.
    features.vault && { url: "/vault", priority: "0.7", changefreq: "monthly" },
    features.forums && { url: "/forums", priority: "0.7", changefreq: "daily" },
    features.webstore && { url: "/webstore", priority: "0.6", changefreq: "weekly" },
    { url: "/finance", priority: "0.7", changefreq: "weekly" },
    { url: "/staff", priority: "0.6", changefreq: "weekly" },
    features.applications && { url: "/apply", priority: "0.7", changefreq: "weekly" },
    features.watch && { url: "/watch", priority: "0.7", changefreq: "daily" },
    features.events && { url: "/events", priority: "0.7", changefreq: "daily" },
    features.shopdirectory && { url: "/shopdirectory", priority: "0.6", changefreq: "daily" },
    features.discord?.punishments && { url: "/punishments", priority: "0.4", changefreq: "daily" },
    { url: "/appeal", priority: "0.5", changefreq: "monthly" },
    features.report && { url: "/report", priority: "0.5", changefreq: "monthly" },
    { url: "/rules", priority: "0.6", changefreq: "monthly" },
    { url: "/terms", priority: "0.3", changefreq: "monthly" },
    { url: "/privacy", priority: "0.3", changefreq: "monthly" },
    { url: "/refund", priority: "0.3", changefreq: "monthly" },
  ].filter(Boolean);
}

export default function sitemapRoutes(app, config, features) {
  const rawUrl = config?.siteConfiguration?.siteUrl;
  if (!rawUrl) {
    console.warn("[sitemapRoutes] config.siteConfiguration.siteUrl is not set — sitemap, robots.txt and llms.txt routes will be skipped.");
    return;
  }
  const baseUrl = rawUrl.replace(/\/$/, "");
  const sc = config.siteConfiguration || {};
  const platforms = sc.platforms || {};
  const today = () => new Date().toISOString().slice(0, 10);

  app.get("/robots.txt", function (req, res) {
    const ruleBlock = (agent) =>
      [`User-agent: ${agent}`, "Allow: /", ...DISALLOW.map((p) => `Disallow: ${p}`)].join("\n");

    const lines = [
      "# Search engines and AI answer engines are welcome to crawl and cite this site.",
      ruleBlock("*"),
      "",
      ...AI_USER_AGENTS.flatMap((agent) => [ruleBlock(agent), ""]),
      `Sitemap: ${baseUrl}/sitemap.xml`,
      `# GEO map for LLMs: ${baseUrl}/llms.txt`,
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  // llms.txt — https://llmstxt.org/ — a curated, model-friendly map of the
  // site's canonical pages, so generative engines can ground answers on the
  // right URLs instead of guessing.
  app.get("/llms.txt", function (req, res) {
    const L = [];
    L.push(`# ${sc.siteName || "Website"}`);
    L.push("");
    L.push(
      `> ${sc.tagline ? sc.tagline + ". " : ""}${sc.siteName || "This site"} is the community website for a Christian Minecraft server: server info and how to join, ranks and perks, community rules, staff applications, forums, events and live player stats.`
    );
    L.push("");
    if (sc.email) L.push(`Contact: ${sc.email}`);
    if (platforms.discord) L.push(`Discord: ${platforms.discord}`);
    if (platforms.webstore) L.push(`Store: ${platforms.webstore}`);
    if (platforms.knowledgebase) L.push(`Knowledge base: ${platforms.knowledgebase}`);
    L.push("");

    L.push("## Main pages");
    L.push(`- [Home](${baseUrl}/): what ${sc.siteName || "the network"} is and current player activity`);
    if (features.server) L.push(`- [Play / how to join](${baseUrl}/play): Java and Bedrock server addresses and connection steps`);
    if (features.bedrock) L.push(`- [Bedrock Edition](${baseUrl}/bedrock): how to join on Bedrock - address, port and per-device steps`);
    if (features.ranks) L.push(`- [Ranks](${baseUrl}/ranks): available ranks, their perks and pricing`);
    L.push(`- [Rules](${baseUrl}/rules): the community rules every player agrees to`);
    if (features.applications) L.push(`- [Apply](${baseUrl}/apply): open staff positions and how to apply`);
    L.push(`- [Staff](${baseUrl}/staff): the volunteer team that runs the community`);
    if (features.report) L.push(`- [Report a player](${baseUrl}/report): report rule-breaking for staff review`);
    L.push(`- [Appeal a punishment](${baseUrl}/appeal): submit a ban or mute appeal`);
    L.push("");

    L.push("## Community");
    if (features.forums) L.push(`- [Forums](${baseUrl}/forums): community discussion boards`);
    if (features.vault) L.push(`- [Map archive](${baseUrl}/vault): every past world with its dates, seed and download`);
    if (features.webstore) L.push(`- [Store](${baseUrl}/webstore): ranks and perks available to buy`);
    if (features.events) L.push(`- [Events](${baseUrl}/events): upcoming and past community events`);
    if (features.watch) L.push(`- [Watch](${baseUrl}/watch): community creator content and streams`);
    if (features.shopdirectory) L.push(`- [Player shop directory](${baseUrl}/shopdirectory): in-game player-run stores, items and prices`);
    if (features.discord?.punishments) L.push(`- [Punishment log](${baseUrl}/punishments): the public moderation log`);
    L.push("");

    L.push("## Policies");
    L.push(`- [Terms of Service](${baseUrl}/terms)`);
    L.push(`- [Privacy Policy](${baseUrl}/privacy)`);
    L.push(`- [Refund Policy](${baseUrl}/refund)`);
    L.push("");

    L.push("## Machine-readable");
    L.push(`- [XML sitemap](${baseUrl}/sitemap.xml)`);
    L.push("");

    res.type("text/plain; charset=utf-8").send(L.join("\n"));
  });

  app.get("/sitemap.xml", async function (req, res) {
    const day = today();

    const staticPages = staticSitemapPages(features).map((p) => ({ lastmod: day, ...p }));

    let forumUrls = [];
    try {
      // Empty permissions = anonymous user; only publicly accessible content.
      const { flat = [] } = await getCategoriesForUser([]);
      const categoryIds = flat.map((c) => c.categoryId);

      for (const cat of flat) {
        forumUrls.push({
          url: `/forums/category/${cat.slug}`,
          priority: "0.6",
          changefreq: "daily",
          lastmod: day,
        });
      }

      if (categoryIds.length) {
        const { discussions } = await getRecentDiscussions({
          categoryIds,
          page: 1,
          perPage: 200,
        });
        for (const d of discussions) {
          const path = d.slug
            ? `/forums/discussion/${d.discussionId}/${d.slug}`
            : `/forums/discussion/${d.discussionId}`;
          const stamp = d.lastReplyAt || d.updatedAt || d.createdAt;
          forumUrls.push({
            url: path,
            priority: "0.5",
            changefreq: "weekly",
            lastmod: stamp ? new Date(stamp).toISOString().slice(0, 10) : day,
          });
        }
      }
    } catch (err) {
      console.error("[SITEMAP] Failed to fetch forum data:", err.message);
    }

    let eventUrls = [];
    if (features.events) {
      try {
        // Anonymous viewer: no ranks, not staff -- the same trick the forum
        // block above uses.
        const { events = [] } = await getAllPublishedEvents(1, 200, [], false);

        for (const event of events) {
          if (!event.slug) continue;

          // `visible` alone is not enough. A rank-locked event is still
          // "visible" to everyone as a redacted teaser, and a page whose
          // substance is withheld is thin content that should not be
          // submitted for indexing.
          const access = resolveEventAccess(event, [], { isStaff: false });
          if (!access.visible || access.locked) continue;

          const stamp = event.updatedAt || event.startAt;
          eventUrls.push({
            url: `/events/${event.slug}`,
            priority: "0.5",
            changefreq: "weekly",
            lastmod: stamp ? new Date(stamp).toISOString().slice(0, 10) : day,
          });
        }
      } catch (err) {
        console.error("[SITEMAP] Failed to fetch events:", err.message);
      }
    }

    const urlEntries = [...staticPages, ...forumUrls, ...eventUrls]
      .map(
        ({ url, priority, changefreq, lastmod }) =>
          `  <url>\n    <loc>${escapeXml(baseUrl + url)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;
    res.type("application/xml").send(xml);
  });
}
