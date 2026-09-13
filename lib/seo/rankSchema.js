/**
 * Turn the public rank catalogue (controllers/rankCatalogController
 * .getRankCatalogForPublicPage) into schema.org nodes + a matching FAQ, so
 * "what ranks does <site> have / how much do they cost / how do I buy one"
 * can be answered directly from the /ranks page by generative engines.
 */

import { absoluteUrl, orgId } from "./jsonLd.js";

function offersFor(config, pkg) {
  return (pkg.prices || [])
    .filter((p) => Number.isFinite(p?.priceCents))
    .map((p) =>
      prune({
        "@type": "Offer",
        price: (p.priceCents / 100).toFixed(2),
        priceCurrency: String(p.currency || "USD").toUpperCase(),
        url: p.stripePriceId ? absoluteUrl(config, `/webstore#ws-${p.stripePriceId}`) : absoluteUrl(config, "/ranks"),
        availability: "https://schema.org/InStock",
        category: p.purchaseType === "subscription" ? "Subscription" : "One-time purchase",
      })
    );
}

function prune(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") delete obj[k];
  }
  return obj;
}

/**
 * @param {object} config
 * @param {Array<{ displayName: string, packages: Array<object> }>} categories
 * @returns {{ itemList: object|null, faq: Array<{q:string,a:string}>, priceRange: {min:number,max:number,currency:string}|null }}
 */
export function rankCatalogSchema(config, categories) {
  const cats = Array.isArray(categories) ? categories : [];
  const products = [];
  const names = [];
  let min = Infinity;
  let max = 0;
  let currency = "USD";
  let anyMonthly = false;
  let anyOneTime = false;

  for (const cat of cats) {
    for (const pkg of cat.packages || []) {
      if (!pkg?.displayName) continue;
      names.push(pkg.displayName);
      const offers = offersFor(config, pkg);
      for (const p of pkg.prices || []) {
        if (Number.isFinite(p?.priceCents)) {
          min = Math.min(min, p.priceCents);
          max = Math.max(max, p.priceCents);
          currency = String(p.currency || currency).toUpperCase();
        }
        if (p?.purchaseType === "subscription") anyMonthly = true;
        else anyOneTime = true;
      }
      products.push(
        prune({
          "@type": "Product",
          name: pkg.displayName,
          description: pkg.description || undefined,
          category: cat.displayName || undefined,
          image: pkg.imageUrl ? absoluteUrl(config, pkg.imageUrl) : undefined,
          brand: { "@id": orgId(config) },
          offers: offers.length ? offers : undefined,
        })
      );
    }
  }

  const priceRange = Number.isFinite(min) && max > 0 ? { min, max, currency } : null;
  const fmt = (cents) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

  const siteName = config?.siteConfiguration?.siteName || "the server";
  const store = config?.siteConfiguration?.platforms?.webstore;

  const faq = [];
  if (names.length) {
    faq.push({
      q: `What ranks are available on ${siteName}?`,
      a: `${siteName} offers ${names.length} rank${names.length === 1 ? "" : "s"}: ${names.join(", ")}. Each rank comes with its own set of in-game perks.`,
    });
  }
  if (priceRange) {
    faq.push({
      q: `How much do ranks cost on ${siteName}?`,
      a:
        priceRange.min === priceRange.max
          ? `Ranks are ${fmt(priceRange.min)}.`
          : `Ranks range from ${fmt(priceRange.min)} to ${fmt(priceRange.max)}.` +
            (anyMonthly && anyOneTime
              ? " Both one-time purchases and monthly subscriptions are available depending on the rank."
              : anyMonthly
              ? " Ranks are billed as a monthly subscription."
              : " Ranks are a one-time purchase."),
    });
  }
  faq.push({
    q: `How do I buy a rank on ${siteName}?`,
    a: `Open the Ranks page, choose a rank, and complete checkout${store ? ` on the webstore (${store})` : ""}. Rank perks are applied to your account automatically after purchase.`,
  });

  const itemList = products.length
    ? prune({
        "@type": "ItemList",
        name: `${siteName} ranks`,
        url: absoluteUrl(config, "/ranks"),
        numberOfItems: products.length,
        itemListElement: products.map((p, i) => ({
          "@type": "ListItem",
          position: i + 1,
          item: p,
        })),
      })
    : null;

  return { itemList, faq, priceRange };
}
