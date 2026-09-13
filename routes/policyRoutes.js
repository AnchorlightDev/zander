import { getGlobalImage } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import {
  buildGraph,
  webPageNode,
  breadcrumbNode,
  faqNode,
  articleNode,
} from "../lib/seo/jsonLd.js";

export default function policySiteRoute(app, config, features) {
  const siteName = config.siteConfiguration.siteName;
  const siteUrl = config.siteConfiguration.siteUrl;
  const discordUrl = config.siteConfiguration.platforms?.discord;

  // Answer-first summary + Q&A for the Rules page. The full ruleset is
  // rendered from an external markdown file client-side (zero-md), which crawlers
  // and LLMs don't execute — so this SSR block carries the gist and the common
  // questions in the HTML, with matching FAQ/Article structured data.
  const rulesSummary = `${siteName} is a Christ-centred community, so its rules focus on treating people with respect: no harassment, hate speech, slurs, discrimination, NSFW or shroom content, spam, advertising, cheating/exploiting, or ban evasion. The rules apply everywhere ${siteName} operates — the Minecraft server, this website and the Discord. Staff decisions are final, and punishments can be appealed.`;
  const rulesFaq = [
    {
      q: `Where can I read the full ${siteName} rules?`,
      a: `The complete, current ruleset is published on ${siteUrl}/rules.`,
    },
    {
      q: `Do the ${siteName} rules apply on Discord as well as in-game?`,
      a: `Yes. The rules apply across the Minecraft server, the website and the Discord server.`,
    },
    {
      q: `How do I report someone breaking the rules on ${siteName}?`,
      a: `Use ${siteUrl}/report to submit a report with evidence${discordUrl ? `, or contact staff in the Discord (${discordUrl})` : ""}. Staff review every report.`,
    },
    {
      q: `What happens if I break a rule on ${siteName}?`,
      a: `Depending on severity, staff may warn, mute, kick or ban. Punishments can be appealed at ${siteUrl}/appeal.`,
    },
  ];
  app.get("/terms", async function (req, res) {
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("policy/termsOfService", {
      pageTitle: `Network Terms Of Service`,
      pageDescription: `Read the Terms of Service for ${config.siteConfiguration.siteName}. By playing on our network you agree to these terms.`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.get("/rules", async function (req, res) {
    const rulesDescription = `Read the community rules for ${siteName}. Everyone playing on the server, using the website or in the Discord is expected to follow these guidelines.`;
    const pageJsonLd = buildGraph(config, [
      webPageNode(config, req, { title: "Network Rules", description: rulesDescription, hasBreadcrumb: true }),
      breadcrumbNode(config, req, [{ name: "Home", url: "/" }, { name: "Rules" }]),
      articleNode(config, {
        headline: `${siteName} Community Rules`,
        description: rulesDescription,
        url: "/rules",
      }),
      faqNode(rulesFaq),
    ]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("policy/rules", {
      pageTitle: `Network Rules`,
      pageDescription: rulesDescription,
      pageJsonLd,
      rulesSummary,
      rulesFaq,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.get("/privacy", async function (req, res) {
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("policy/privacy", {
      pageTitle: `Network Privacy Policy`,
      pageDescription: `Read the Privacy Policy for ${config.siteConfiguration.siteName}. Learn how we collect, use, and protect your data.`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });

  app.get("/refund", async function (req, res) {
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("policy/refund", {
      pageTitle: `Network Refund Policy`,
      pageDescription: `Read the Refund Policy for ${config.siteConfiguration.siteName}. Understand our guidelines for purchases and refund requests.`,
      config: config,
      req: req,
      features: features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    }));
    return;
  });
}
