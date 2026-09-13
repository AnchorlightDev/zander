import { describe, expect, it } from "vitest";
import {
  buildGraph,
  scriptSafe,
  organizationNode,
  breadcrumbNode,
  faqNode,
  howToNode,
  itemListNode,
  canonicalUrl,
  absoluteUrl,
  ROBOTS_INDEX,
} from "../../lib/seo/jsonLd.js";
import { rankCatalogSchema } from "../../lib/seo/rankSchema.js";

const config = {
  siteConfiguration: {
    siteUrl: "https://craftingforchrist.net/",
    siteName: "Crafting For Christ",
    tagline: "Crafting A Christ Centred Gaming Community",
    email: "support@craftingforchrist.net",
    platforms: {
      webstore: "https://crafting-for-christ.tebex.io",
      discord: "https://discord.com/invite/x",
      notAUrl: "hello",
    },
  },
};

/** Reverse scriptSafe's <script>-hardening so the result can be JSON.parsed. */
function parseGraph(str) {
  return JSON.parse(
    str.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&")
  );
}

describe("jsonLd helpers", () => {
  it("normalises URLs", () => {
    expect(absoluteUrl(config, "/ranks")).toBe("https://craftingforchrist.net/ranks");
    expect(absoluteUrl(config, "https://x.test/a")).toBe("https://x.test/a");
    expect(canonicalUrl(config, { url: "/ranks?currency=usd" })).toBe("https://craftingforchrist.net/ranks");
    expect(canonicalUrl(config, {})).toBe("https://craftingforchrist.net/");
  });

  it("builds an Organization node with only real http(s) sameAs entries", () => {
    const org = organizationNode(config);
    expect(org["@id"]).toBe("https://craftingforchrist.net/#organization");
    expect(org.sameAs).toEqual([
      "https://crafting-for-christ.tebex.io",
      "https://discord.com/invite/x",
    ]);
    expect(org.logo).toEqual({
      "@type": "ImageObject",
      url: "https://craftingforchrist.net/images/siteLogo.png",
    });
  });

  it("scriptSafe neutralises <, >, & and line separators", () => {
    const out = scriptSafe({ a: "</script><b> & " + String.fromCharCode(0x2028) });
    expect(out).not.toMatch(/<|>|&(?!amp)/);
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u0026");
    expect(out).toContain("\\u2028");
    // ordinary spaces survive
    expect(scriptSafe({ a: "two words" })).toContain("two words");
  });

  it("buildGraph always includes Organization + WebSite, then extra nodes", () => {
    const graph = parseGraph(
      buildGraph(config, [faqNode([{ q: "Q?", a: "A." }]), null, breadcrumbNode(config, { url: "/x" }, [{ name: "Home", url: "/" }, { name: "X" }])])
    );
    expect(graph["@context"]).toBe("https://schema.org");
    expect(graph["@graph"].map((n) => n["@type"])).toEqual([
      "Organization",
      "WebSite",
      "FAQPage",
      "BreadcrumbList",
    ]);
  });

  it("faqNode / howToNode / itemListNode return null when empty", () => {
    expect(faqNode([])).toBeNull();
    expect(faqNode([{ q: "only q" }])).toBeNull();
    expect(howToNode({ steps: [] })).toBeNull();
    expect(itemListNode({ items: [] }).numberOfItems).toBe(0);
  });

  it("howToNode numbers its steps", () => {
    const ht = howToNode({ name: "Join", steps: ["Open Minecraft", "Add server", "Play"] });
    expect(ht.step.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(ht.step[1].text).toBe("Add server");
  });

  it("exposes a permissive default robots directive", () => {
    expect(ROBOTS_INDEX).toContain("max-snippet:-1");
    expect(ROBOTS_INDEX).toContain("index, follow");
  });
});

describe("rankCatalogSchema", () => {
  const categories = [
    {
      displayName: "Server Ranks",
      packages: [
        {
          displayName: "Disciple",
          description: "Entry rank",
          imageUrl: "/images/ranks/disciple.png",
          prices: [
            { stripePriceId: "price_1", priceCents: 500, currency: "usd", purchaseType: "one_time" },
          ],
        },
        {
          displayName: "Apostle",
          prices: [
            { stripePriceId: "price_2", priceCents: 1500, currency: "usd", purchaseType: "subscription" },
          ],
        },
      ],
    },
  ];

  it("emits an ItemList of Products with Offers and a matching FAQ", () => {
    const { itemList, faq, priceRange } = rankCatalogSchema(config, categories);
    expect(itemList["@type"]).toBe("ItemList");
    expect(itemList.numberOfItems).toBe(2);
    const first = itemList.itemListElement[0].item;
    expect(first["@type"]).toBe("Product");
    expect(first.offers[0]).toMatchObject({
      "@type": "Offer",
      price: "5.00",
      priceCurrency: "USD",
      url: "https://craftingforchrist.net/webstore#ws-price_1",
    });
    expect(first.image).toBe("https://craftingforchrist.net/images/ranks/disciple.png");

    expect(priceRange).toEqual({ min: 500, max: 1500, currency: "USD" });
    const qs = faq.map((f) => f.q);
    expect(qs.some((q) => /available/i.test(q))).toBe(true);
    expect(qs.some((q) => /cost/i.test(q))).toBe(true);
    expect(qs.some((q) => /how do i buy/i.test(q))).toBe(true);
    const costA = faq.find((f) => /cost/i.test(f.q)).a;
    expect(costA).toMatch(/\$5\.00/);
    expect(costA).toMatch(/\$15\.00/);
    expect(costA).toMatch(/one-time purchases and monthly subscriptions/i);
  });

  it("degrades gracefully with an empty catalogue", () => {
    const { itemList, faq, priceRange } = rankCatalogSchema(config, []);
    expect(itemList).toBeNull();
    expect(priceRange).toBeNull();
    expect(faq.length).toBe(1); // just the "how do I buy" evergreen answer
  });
});
