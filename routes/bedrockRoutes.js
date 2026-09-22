/**
 * routes/bedrockRoutes.js
 *
 * Public landing page for Minecraft Bedrock Edition players.
 *
 * /play already covers both editions at once. This page exists because Bedrock
 * is its own search query and its own set of problems -- a port to type in, a
 * different Add Server flow per device, and consoles that will not let you type
 * an address at all. None of that fits on a page that also has to serve Java
 * players.
 *
 * Nothing here is specific to any one community: every address comes from
 * config.connection, every string from lang.json, and the whole route is behind
 * features.bedrock.
 */

import { getGlobalImage, isFeatureWebRouteEnabled } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import { getConnectionDetails } from "../lib/connectionDetails.mjs";
import { createTranslator } from "../lib/langText.mjs";
import {
  ROBOTS_NOINDEX,
  breadcrumbNode,
  buildGraph,
  faqNode,
  howToNode,
  webPageNode,
} from "../lib/seo/jsonLd.js";

export default function bedrockSiteRoutes(app, config, features, lang) {
  app.get("/bedrock", async function (req, res) {
    if (!(await isFeatureWebRouteEnabled(app, features.bedrock, req, res, features))) return;

    const siteName = config.siteConfiguration?.siteName ?? "the server";
    const platforms = config.siteConfiguration?.platforms ?? {};
    const { bedrock } = getConnectionDetails(config);

    const t = createTranslator(lang, {
      SITENAME: siteName,
      BEDROCK_HOST: bedrock.host ?? "",
      BEDROCK_PORT: bedrock.port ?? "",
      BEDROCK_ADDRESS: bedrock.address ?? "",
    });

    const pageTitle = t("bedrock.pageTitle") || "Bedrock Edition";
    const pageDescription = t("bedrock.metaDescription");

    // A page that cannot tell anyone the address is not worth indexing: it
    // would rank for "<server> bedrock" and then answer the question with a
    // shrug. It still renders, so an operator who has half-configured this can
    // see what is missing.
    const pageRobots = bedrock.configured ? undefined : ROBOTS_NOINDEX;

    const nodes = [
      webPageNode(config, req, {
        title: pageTitle,
        description: pageDescription,
        hasBreadcrumb: true,
      }),
      breadcrumbNode(config, req, [{ name: "Home", url: "/" }, { name: pageTitle }]),
    ];

    // Structured data only where there is a real answer to give. An empty
    // address in a FAQ answer is worse than no FAQ at all.
    if (bedrock.configured) {
      const windowsSteps = t.list("bedrock.windowsSteps");
      if (windowsSteps.length) {
        nodes.push(
          howToNode({
            name: `How to join ${siteName} on Minecraft Bedrock Edition`,
            description: t("bedrock.intro"),
            steps: windowsSteps,
          })
        );
      }

      nodes.push(
        faqNode(
          [
            {
              q: `What is the Bedrock server address for ${siteName}?`,
              a: bedrock.port
                ? `${bedrock.host}, port ${bedrock.port}.`
                : `${bedrock.host}.`,
            },
            t.has("bedrock.consoleNote")
              ? {
                  q: `Can I join ${siteName} on Xbox, PlayStation or Switch?`,
                  a: t("bedrock.consoleNote"),
                }
              : null,
          ].filter(Boolean)
        )
      );
    }

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/play/bedrock", {
        pageTitle,
        pageDescription,
        pageRobots,
        pageJsonLd: buildGraph(config, nodes),
        config,
        req,
        features,
        t,
        bedrock,
        discordUrl: platforms.discord ?? null,
        knowledgebaseUrl: platforms.knowledgebase ?? null,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
  });
}
