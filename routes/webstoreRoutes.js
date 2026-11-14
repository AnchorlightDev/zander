/**
 * webstoreRoutes.js
 *
 * Public-facing routes for the Webstore module.
 *
 * Routes:
 *   GET  /webstore              — storefront listing
 *   POST /webstore/checkout     — start a Stripe Checkout session
 *   GET  /webstore/thank-you    — post-payment landing page
 *   GET  /webstore/history      — authenticated purchase history + live subscriptions
 *   POST /webstore/billing-portal — open the Stripe Billing Portal for a subscription the user pays for
 *   GET  /give                  — legacy redirect to the Finance Centre support section
 */

import {
  getGlobalImage,
  isLoggedIn,
  setBannerCookie,
} from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import {
  createPendingPurchase,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  findWebstoreItem,
  formatPrice,
  getBillingCustomerForPurchaser,
  getPurchaseHistory,
  getPurchaseHistoryCount,
  getReceivedGifts,
  getReceivedGiftsCount,
  getUserSubscriptions,
  getWebstoreItems,
  preferredCurrencyFromLocale,
  syncStripeStorefrontCategories,
} from "../controllers/webstoreController.js";
import { getAllCategories } from "../controllers/webstoreCategoryController.js";
import { getAllItemSettings } from "../controllers/webstoreItemSettingsController.js";
import { getRankCatalogForPublicPage } from "../controllers/rankCatalogController.js";
import {
  applyItemSettings,
  groupByCategory,
  isPubliclyVisible,
} from "../lib/webstore/catalogVisibility.mjs";
import { describeSubscription } from "../lib/webstore/subscriptionView.mjs";
import {
  buildGraph,
  webPageNode,
  breadcrumbNode,
  faqNode,
} from "../lib/seo/jsonLd.js";
import { rankCatalogSchema } from "../lib/seo/rankSchema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a best-effort locale from the Accept-Language header.
 * Entries carry optional weights ("en-us;q=0.7") and may be "*" or malformed,
 * any of which would make Intl.NumberFormat throw, so each candidate is
 * stripped and validated before use.
 */
function parseLocale(req) {
  const header = req.headers["accept-language"];
  if (typeof header !== "string") return "en-US";
  for (const entry of header.split(",")) {
    const tag = entry.split(";")[0].trim();
    if (!tag || tag === "*") continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(tag);
      if (canonical) return canonical;
    } catch {
      // invalid tag -- try the next one
    }
  }
  return "en-US";
}

/** Validate a Minecraft username: 1-16 alphanumeric / underscore characters. */
function isValidMinecraftUsername(name) {
  return typeof name === "string" && /^[A-Za-z0-9_]{1,16}$/.test(name);
}

/**
 * Build a lookup from Stripe price ID to the curated rank-catalog content
 * (perk list, plus a description/image to fall back on). This is what lets the
 * storefront show the rich perk breakdown the old /ranks page used to, keyed off
 * the live Stripe product each card already renders.
 *
 * @param {Array<{ packages: Array<object> }>} rankCategories  from getRankCatalogForPublicPage()
 * @returns {Map<string, { perks: Array, description: string|null, imageUrl: string|null }>}
 */
function buildPerkOverlay(rankCategories) {
  const byPrice = new Map();
  for (const group of Array.isArray(rankCategories) ? rankCategories : []) {
    for (const pkg of group?.packages || []) {
      const overlay = {
        perks: Array.isArray(pkg.perks) ? pkg.perks : [],
        description: pkg.description || null,
        imageUrl: pkg.imageUrl || null,
      };
      for (const priceId of pkg.stripePriceIds || []) {
        byPrice.set(String(priceId), overlay);
      }
    }
  }
  return byPrice;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export default function webstoreRoutes(app, config, features) {
  // -------------------------------------------------------------------------
  // GET /webstore — public storefront
  // -------------------------------------------------------------------------
  app.get("/webstore", async function (req, res) {
    if (!features.webstore) {
      return res.redirect("/");
    }

    if (req.query?.canceled) {
      setBannerCookie("info", "Checkout cancelled. You can try again whenever you're ready.", res);
    }

    const loggedIn = isLoggedIn(req);
    const locale = parseLocale(req);
    const preferredCurrency = preferredCurrencyFromLocale(locale);

    console.log(`[webstore] storefront visited | user=${loggedIn ? req.session.user.userId : "guest"} locale=${locale} currency=${preferredCurrency || "default"}`);

    // Require a linked Minecraft account before allowing purchases
    if (loggedIn && !req.session?.user?.username) {
      console.log(`[webstore] user ${req.session.user.userId} has no linked Minecraft account — redirecting to profile`);
      setBannerCookie(
        "warning",
        "Please link your Minecraft account before purchasing.",
        res
      );
      return res.redirect("/profile");
    }

    let items = [];
    let categoryGroups = [];
    let useCategories = false;
    let itemsError = false;
    // The curated rank catalog now feeds this page too (it used to drive the
    // separate /ranks page): its perks overlay the matching Stripe products, and
    // it still powers the rank structured data for search / generative engines.
    let rankCategories = [];
    try {
      // getWebstoreItems() deliberately returns everything -- it also serves
      // checkout and renewal. Hiding happens here, on the way to the page.
      const rawItems = await getWebstoreItems(preferredCurrency);

      // Seed categories from each product's Stripe `metadata.category` before
      // grouping, so a product categorised in Stripe shows up grouped without
      // any dashboard step. A dashboard assignment still wins (see the sync).
      await syncStripeStorefrontCategories(rawItems).catch((err) =>
        console.warn("[webstore] Stripe category sync skipped:", err.message)
      );

      const [settings, categories, catalog] = await Promise.all([
        getAllItemSettings().catch(() => []),
        getAllCategories().catch(() => []),
        getRankCatalogForPublicPage(preferredCurrency).catch((err) => {
          console.warn("[webstore] rank catalog overlay skipped:", err.message);
          return [];
        }),
      ]);
      rankCategories = catalog;
      const perkOverlay = buildPerkOverlay(rankCategories);

      const decorated = applyItemSettings(rawItems, settings, categories).map((item) => {
        const overlay = perkOverlay.get(String(item.stripePriceId));
        return {
          ...item,
          priceDisplay: formatPrice(item.priceCents, item.currency, locale),
          purchaseLabel: item.purchaseType === "subscription" ? "Subscribe" : "Buy Now",
          badgeLabel: item.purchaseType === "subscription" ? "Monthly" : "One-time",
          // Rich perk breakdown from the rank catalog, when this product is one.
          perks: overlay?.perks || [],
          // Stripe stays the source of truth for name and price; the curated
          // description/image only fill in when Stripe has none of its own.
          description: item.description || overlay?.description || null,
          imageUrl: item.imageUrl || overlay?.imageUrl || null,
        };
      });

      categoryGroups = groupByCategory(decorated, { publicOnly: true });
      // Until somebody actually assigns a category, the page stays the flat
      // list it has always been rather than growing an "Uncategorised" heading.
      useCategories = categoryGroups.some((g) => g.id !== null);
      items = categoryGroups.flatMap((g) => g.packages);

      const hidden = decorated.length - items.length;
      console.log(
        `[webstore] loaded ${items.length} item(s) for storefront` +
        (hidden > 0 ? ` (${hidden} hidden)` : "")
      );
    } catch (err) {
      console.error("[webstore] Failed to load items:", err.message);
      itemsError = true;
    }

    const pageDescription = `Support ${config.siteConfiguration.siteName} with ranks, perks, and more. Browse every rank, its perks and its price, then check out in a few clicks.`;
    // Rank structured data (ItemList of products + FAQ) now lives on this page,
    // since /ranks folded into the storefront and redirects here.
    const { itemList: rankItemList, faq: rankFaq } = rankCatalogSchema(config, rankCategories);
    const pageJsonLd = buildGraph(config, [
      webPageNode(config, req, { title: "Webstore", description: pageDescription, hasBreadcrumb: true }),
      breadcrumbNode(config, req, [{ name: "Home", url: "/" }, { name: "Webstore" }]),
      rankItemList,
      faqNode(rankFaq),
    ]);

    return res.view("modules/webstore/index", {
      pageTitle: "Webstore",
      pageDescription,
      pageJsonLd,
      rankFaq,
      config,
      req,
      features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      items,
      categoryGroups,
      useCategories,
      itemsError,
      username: loggedIn ? req.session.user.username : null,
      loggedIn,
    });
  });

  // -------------------------------------------------------------------------
  // POST /webstore/checkout — create Stripe Checkout session
  // -------------------------------------------------------------------------
  app.post("/webstore/checkout", async function (req, res) {
    if (!features.webstore) return res.redirect("/");

    if (!isLoggedIn(req)) {
      return res.redirect("/login?returnTo=/webstore");
    }

    const purchaserUsername = req.session?.user?.username;
    if (!purchaserUsername) {
      console.log(`[webstore] checkout attempted by user ${req.session?.user?.userId} with no linked Minecraft account`);
      setBannerCookie("warning", "Please link your Minecraft account before purchasing.", res);
      return res.redirect("/profile");
    }

    const itemSlug = typeof req.body?.itemSlug === "string" ? req.body.itemSlug.trim() : "";
    if (!itemSlug) {
      console.log(`[webstore] checkout attempted with missing itemSlug | user=${req.session.user.userId}`);
      setBannerCookie("warning", "Invalid item.", res);
      return res.redirect("/webstore");
    }

    console.log(`[webstore] checkout initiated | user=${req.session.user.userId} username=${purchaserUsername} itemSlug=${itemSlug}`);

    let item;
    try {
      item = await findWebstoreItem(itemSlug);
    } catch (err) {
      console.error("[webstore] findWebstoreItem error:", err.message);
      item = null;
    }

    if (!item) {
      setBannerCookie("warning", "That item is no longer available.", res);
      return res.redirect("/webstore");
    }

    if (!item.stripePriceId) {
      setBannerCookie("danger", "Item configuration error — please contact staff.", res);
      return res.redirect("/webstore");
    }

    // findWebstoreItem() does not filter -- renewal depends on it resolving
    // hidden items -- so the storefront has to refuse them itself. Without this
    // a hidden product is still purchasable by posting its slug.
    try {
      const [settings, categories] = await Promise.all([
        getAllItemSettings(),
        getAllCategories(),
      ]);
      const [decorated] = applyItemSettings([item], settings, categories);
      if (!isPubliclyVisible(decorated)) {
        console.log(`[webstore] checkout refused for hidden item | user=${req.session.user.userId} itemSlug=${itemSlug}`);
        setBannerCookie("warning", "That item is no longer available.", res);
        return res.redirect("/webstore");
      }
    } catch (err) {
      // A settings lookup failure must not block a legitimate purchase; the
      // item was already resolved and is assumed visible, as it was before
      // this table existed.
      console.error("[webstore] visibility check failed, allowing checkout:", err.message);
    }

    // --- Determine recipient ---
    const purchaseFor = typeof req.body?.purchaseFor === "string"
      ? req.body.purchaseFor.trim()
      : "self";

    let recipientUsername;
    let isGift = false;
    let isAnonymous = false;

    if (purchaseFor === "gift") {
      const raw = typeof req.body?.recipientUsername === "string"
        ? req.body.recipientUsername.trim()
        : "";

      if (!raw) {
        setBannerCookie("warning", "Please enter the recipient's Minecraft username.", res);
        return res.redirect("/webstore");
      }

      if (!isValidMinecraftUsername(raw)) {
        setBannerCookie(
          "warning",
          "Recipient username must be 1-16 characters (letters, numbers, underscores).",
          res
        );
        return res.redirect("/webstore");
      }

      // Prevent gifting to yourself (not inherently wrong but avoids confusion)
      if (raw.toLowerCase() === purchaserUsername.toLowerCase()) {
        setBannerCookie("info", "To purchase for yourself, select 'My account'.", res);
        return res.redirect("/webstore");
      }

      recipientUsername = raw;
      isGift = true;
      isAnonymous = req.body?.giftAnonymous === "1";
    } else {
      recipientUsername = purchaserUsername;
    }

    // --- Create Stripe Checkout session ---
    let session;
    try {
      session = await createStripeCheckoutSession({
        item,
        userId: req.session.user.userId,
        recipientMinecraftUsername: recipientUsername,
        purchaserMinecraftUsername: purchaserUsername,
        isGift,
        isAnonymous,
      });
      console.log(`[webstore] Stripe session created | sessionId=${session.id} user=${req.session.user.userId} item=${item.slug} recipient=${recipientUsername} isGift=${isGift} anonymous=${isAnonymous}`);
    } catch (err) {
      console.error("[webstore] Stripe checkout session error:", err.message);
      setBannerCookie(
        "danger",
        "We could not start checkout right now. Please try again shortly.",
        res
      );
      return res.redirect("/webstore");
    }

    // --- Persist pending purchase record ---
    try {
      await createPendingPurchase({
        userId: req.session.user.userId,
        item,
        purchaserMinecraftUsername: purchaserUsername,
        recipientMinecraftUsername: recipientUsername,
        stripeSessionId: session.id,
        isGift,
        isAnonymous,
      });
      console.log(`[webstore] pending purchase recorded | sessionId=${session.id} user=${req.session.user.userId} item=${item.slug}`);
    } catch (err) {
      // Fail closed: the webhook fulfils from this row, so a customer who paid
      // without it would be charged and granted nothing. The unused Stripe
      // session simply expires.
      console.error(`[webstore] createPendingPurchase error | sessionId=${session.id}:`, err.message);
      setBannerCookie(
        "danger",
        "We could not start checkout right now. Please try again shortly.",
        res
      );
      return res.redirect("/webstore");
    }

    if (!session.url) {
      console.error(`[webstore] Stripe session has no URL | sessionId=${session.id}`);
      setBannerCookie("danger", "Checkout session creation failed. Please try again.", res);
      return res.redirect("/webstore");
    }

    console.log(`[webstore] redirecting to Stripe checkout | sessionId=${session.id}`);
    return res.redirect(session.url);
  });

  // -------------------------------------------------------------------------
  // GET /webstore/thank-you — post-payment landing page
  // -------------------------------------------------------------------------
  app.get("/webstore/thank-you", async function (req, res) {
    if (!features.webstore) return res.redirect("/");

    if (!isLoggedIn(req)) {
      return res.redirect("/login?returnTo=/webstore/thank-you");
    }

    const sessionId = req.query?.session_id || "unknown";
    console.log(`[webstore] thank-you page visited | user=${req.session.user.userId} sessionId=${sessionId}`);

    return res.view("modules/webstore/thank-you", {
      pageTitle: "Thank You",
      pageDescription: "Your purchase is being processed.",
      config,
      req,
      features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      // discord_role perks are deferred until the recipient links Discord;
      // linking re-drives them (retryDeferredDiscordRoles), so prompt here.
      discordLinked: Boolean(req.session.user.discordID),
    });
  });

  // -------------------------------------------------------------------------
  // GET /webstore/history — authenticated purchase history
  // -------------------------------------------------------------------------
  app.get("/webstore/history", async function (req, res) {
    if (!features.webstore) return res.redirect("/");

    if (!isLoggedIn(req)) {
      return res.redirect("/login?returnTo=/webstore/history");
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const giftPage = Math.max(1, parseInt(req.query.giftPage, 10) || 1);
    const limit = 15;
    const offset = (page - 1) * limit;
    const giftOffset = (giftPage - 1) * limit;

    const userId = req.session.user.userId;
    const minecraftUsername = req.session.user.username;

    console.log(`[webstore] purchase history requested | user=${userId} page=${page} giftPage=${giftPage}`);

    let purchases = [];
    let totalCount = 0;
    let receivedGifts = [];
    let receivedGiftsTotal = 0;
    let subscriptions = [];

    try {
      let subscriptionRows;
      [purchases, totalCount, receivedGifts, receivedGiftsTotal, subscriptionRows] = await Promise.all([
        getPurchaseHistory(userId, limit, offset),
        getPurchaseHistoryCount(userId),
        minecraftUsername ? getReceivedGifts(minecraftUsername, limit, giftOffset) : [],
        minecraftUsername ? getReceivedGiftsCount(minecraftUsername) : 0,
        getUserSubscriptions(userId, minecraftUsername),
      ]);
      subscriptions = subscriptionRows.map((row) => describeSubscription(row, userId));
      console.log(`[webstore] purchase history loaded | user=${userId} purchases=${totalCount} receivedGifts=${receivedGiftsTotal} subscriptions=${subscriptions.length}`);
    } catch (err) {
      console.error("[webstore] getPurchaseHistory error:", err.message);
      setBannerCookie("warning", "Could not load purchase history right now.", res);
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const receivedGiftsTotalPages = Math.max(1, Math.ceil(receivedGiftsTotal / limit));

    return res.view("modules/webstore/history", {
      pageTitle: "Purchase History",
      pageDescription: "Your webstore purchase history.",
      config,
      req,
      features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      purchases,
      page,
      totalPages,
      totalCount,
      receivedGifts,
      receivedGiftsTotal,
      giftPage,
      receivedGiftsTotalPages,
      subscriptions,
    });
  });

  // -------------------------------------------------------------------------
  // POST /webstore/billing-portal — hand the purchaser to Stripe to manage
  // -------------------------------------------------------------------------
  app.post("/webstore/billing-portal", async function (req, res) {
    if (!features.webstore) return res.redirect("/");

    if (!isLoggedIn(req)) {
      return res.redirect("/login?returnTo=/webstore/history");
    }

    const userId = req.session.user.userId;
    const subscriptionId = parseInt(req.body?.subscriptionId, 10);
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      setBannerCookie("warning", "Invalid subscription.", res);
      return res.redirect("/webstore/history");
    }

    let customerId = null;
    try {
      // Ownership is enforced here: only the paying user resolves a customer.
      customerId = await getBillingCustomerForPurchaser(userId, subscriptionId);
    } catch (err) {
      console.error("[webstore] getBillingCustomerForPurchaser error:", err.message);
    }

    if (!customerId) {
      console.log(`[webstore] billing portal refused | user=${userId} subscription=${subscriptionId}`);
      setBannerCookie("warning", "You can only manage subscriptions you pay for.", res);
      return res.redirect("/webstore/history");
    }

    try {
      const portal = await createStripeBillingPortalSession(
        customerId,
        `${process.env.siteAddress}/webstore/history`
      );
      console.log(`[webstore] billing portal opened | user=${userId} subscription=${subscriptionId}`);
      return res.redirect(portal.url, 303);
    } catch (err) {
      console.error("[webstore] createStripeBillingPortalSession error:", err.message);
      setBannerCookie("danger", "Could not open billing management right now. Please try again later.", res);
      return res.redirect("/webstore/history");
    }
  });

  // -------------------------------------------------------------------------
  // GET /give — legacy entry point now redirected to the Finance Centre support section
  // -------------------------------------------------------------------------
  app.get("/give", async function (req, res) {
    return res.redirect("/finance#support", 301);
  });
}
