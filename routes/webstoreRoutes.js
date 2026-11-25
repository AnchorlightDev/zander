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
  isPhysicalItem,
  quotePhysicalShipping,
} from "../controllers/webstoreController.js";
import { isPrintifyConfigured, PrintifyError } from "../lib/printify/client.mjs";
import { getAllCategories } from "../controllers/webstoreCategoryController.js";
import { UserGetter } from "../controllers/userController.js";
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
 * Build a lookup from Stripe price ID to the curated rank-catalog content: the
 * perk list, a description/image to fall back on, and the category the rank was
 * filed under. This is what lets the storefront show the rich perk breakdown and
 * the category grouping the old /ranks page used to, keyed off the live Stripe
 * product each card already renders.
 *
 * Category matters because the two pages assign categories in different places:
 * the storefront groups by webstoreItemSettings (per Stripe price), while ranks
 * were grouped by rankCatalog.categoryId. Without carrying it across, a rank
 * categorised in the catalog would show up ungrouped on the webstore.
 *
 * @param {Array<{ packages: Array<object> }>} rankCategories  from getRankCatalogForPublicPage()
 * @returns {Map<string, object>}  overlay keyed by Stripe price ID
 */
function buildPerkOverlay(rankCategories) {
  const byPrice = new Map();
  for (const group of Array.isArray(rankCategories) ? rankCategories : []) {
    for (const pkg of group?.packages || []) {
      const overlay = {
        perks: Array.isArray(pkg.perks) ? pkg.perks : [],
        description: pkg.description || null,
        imageUrl: pkg.imageUrl || null,
        categoryId: pkg.categoryId ?? null,
        categoryName: pkg.categoryName ?? null,
        categoryVisible: pkg.categoryVisible,
        categorySortOrder: Number(pkg.categorySortOrder) || 0,
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
        // A webstore category assignment (webstoreItemSettings) wins; otherwise
        // fall back to the category the rank was filed under in the catalog, so
        // ranks stay grouped on the storefront exactly as they were on /ranks.
        const useCatalogCategory =
          overlay && item.categoryId == null && overlay.categoryId != null;
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
          ...(useCatalogCategory
            ? {
                categoryId: overlay.categoryId,
                categoryName: overlay.categoryName,
                categoryVisible: overlay.categoryVisible,
                categorySortOrder: overlay.categorySortOrder,
              }
            : {}),
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
  // GET /webstore/ship — shipping-address form for a physical (Printify) item
  // -------------------------------------------------------------------------
  // Stripe's hosted Checkout can't price shipping from the address the buyer
  // types on Stripe's page, so for physical goods we collect the address here
  // first, quote Printify live, then hand Stripe a fixed shipping line.
  app.get("/webstore/ship", async function (req, res) {
    if (!features.webstore) return res.redirect("/");
    if (!isLoggedIn(req)) return res.redirect("/login?returnTo=/webstore");

    const itemSlug = typeof req.query?.item === "string" ? req.query.item.trim() : "";
    let item = null;
    try {
      item = itemSlug ? await findWebstoreItem(itemSlug) : null;
    } catch (err) {
      console.error("[webstore] ship: findWebstoreItem error:", err.message);
    }

    if (!item || !isPhysicalItem(item)) {
      setBannerCookie("warning", "That item is no longer available.", res);
      return res.redirect("/webstore");
    }

    // Respect the storefront's own visibility rules (same as checkout).
    try {
      const [settings, categories] = await Promise.all([getAllItemSettings(), getAllCategories()]);
      const [decorated] = applyItemSettings([item], settings, categories);
      if (!isPubliclyVisible(decorated)) {
        setBannerCookie("warning", "That item is no longer available.", res);
        return res.redirect("/webstore");
      }
    } catch (err) {
      console.error("[webstore] ship: visibility check failed, allowing:", err.message);
    }

    if (!isPrintifyConfigured()) {
      setBannerCookie("danger", "Physical orders are temporarily unavailable. Please try again later.", res);
      return res.redirect("/webstore");
    }

    return res.view("modules/webstore/ship", {
      pageTitle: `Ship ${item.displayName}`,
      pageDescription: "Enter your shipping address.",
      config,
      req,
      features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      item,
      priceLabel: formatPrice(item.priceCents, item.currency),
      prefill: {
        name: req.session.user?.username || "",
        email: req.session.user?.email || "",
      },
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

    // --- Physical (Printify) items: collect address, quote shipping live ---
    if (isPhysicalItem(item)) {
      if (!isPrintifyConfigured()) {
        setBannerCookie("danger", "Physical orders are temporarily unavailable. Please try again later.", res);
        return res.redirect("/webstore");
      }

      const b = req.body || {};
      const address = {
        name: (typeof b.shipName === "string" ? b.shipName : "").trim(),
        email: (typeof b.shipEmail === "string" ? b.shipEmail : "").trim(),
        phone: (typeof b.shipPhone === "string" ? b.shipPhone : "").trim(),
        address1: (typeof b.shipAddress1 === "string" ? b.shipAddress1 : "").trim(),
        address2: (typeof b.shipAddress2 === "string" ? b.shipAddress2 : "").trim(),
        city: (typeof b.shipCity === "string" ? b.shipCity : "").trim(),
        region: (typeof b.shipRegion === "string" ? b.shipRegion : "").trim(),
        zip: (typeof b.shipZip === "string" ? b.shipZip : "").trim(),
        country: (typeof b.shipCountry === "string" ? b.shipCountry : "").trim().toUpperCase(),
      };

      // No address yet (came straight from the storefront modal) or an
      // incomplete one → send them to the address form for this item.
      const required = [address.name, address.address1, address.city, address.zip, address.country, address.email];
      if (required.some((v) => !v)) {
        return res.redirect(`/webstore/ship?item=${encodeURIComponent(item.slug)}`);
      }

      // Split the single name field into the first/last Printify expects.
      const nameParts = address.name.split(/\s+/);
      const quoteAddress = {
        firstName: nameParts[0] || address.name,
        lastName: nameParts.slice(1).join(" ") || "",
        email: address.email,
        phone: address.phone,
        country: address.country,
        region: address.region,
        address1: address.address1,
        address2: address.address2,
        city: address.city,
        zip: address.zip,
      };

      let shippingCents;
      try {
        shippingCents = await quotePhysicalShipping(item, quoteAddress);
      } catch (err) {
        const detail = err instanceof PrintifyError ? ` (${err.status || "network"})` : "";
        console.error(`[webstore] Printify shipping quote failed | item=${item.slug}${detail}:`, err.message);
        setBannerCookie("danger", "We couldn't work out shipping for that address right now. Please check it and try again.", res);
        return res.redirect(`/webstore/ship?item=${encodeURIComponent(item.slug)}`);
      }

      if (shippingCents == null) {
        console.log(`[webstore] no standard shipping rate | item=${item.slug} country=${address.country}`);
        setBannerCookie("warning", "Sorry, we can't ship that item to the address you entered.", res);
        return res.redirect(`/webstore/ship?item=${encodeURIComponent(item.slug)}`);
      }

      let physSession;
      try {
        physSession = await createStripeCheckoutSession({
          item,
          userId: req.session.user.userId,
          recipientMinecraftUsername: purchaserUsername,
          purchaserMinecraftUsername: purchaserUsername,
          isGift: false,
          shippingCents,
          shippingCurrency: item.currency,
          shippingLabel: "Shipping (standard)",
        });
      } catch (err) {
        console.error("[webstore] physical checkout session error:", err.message);
        setBannerCookie("danger", "We could not start checkout right now. Please try again shortly.", res);
        return res.redirect(`/webstore/ship?item=${encodeURIComponent(item.slug)}`);
      }

      try {
        await createPendingPurchase({
          userId: req.session.user.userId,
          item,
          purchaserMinecraftUsername: purchaserUsername,
          recipientMinecraftUsername: purchaserUsername,
          stripeSessionId: physSession.id,
          isGift: false,
          fulfillmentType: "printify",
          shippingAddress: address,
          shippingCents,
        });
      } catch (err) {
        console.error(`[webstore] createPendingPurchase (physical) error | sessionId=${physSession.id}:`, err.message);
        setBannerCookie("danger", "We could not start checkout right now. Please try again shortly.", res);
        return res.redirect(`/webstore/ship?item=${encodeURIComponent(item.slug)}`);
      }

      if (!physSession.url) {
        setBannerCookie("danger", "Checkout session creation failed. Please try again.", res);
        return res.redirect(`/webstore/ship?item=${encodeURIComponent(item.slug)}`);
      }
      console.log(`[webstore] redirecting to Stripe checkout (physical) | sessionId=${physSession.id} item=${item.slug} shipping=${shippingCents}`);
      return res.redirect(physSession.url);
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

      // Gifts are granted by Minecraft username, so a typo or a name that has
      // never joined would be charged and fulfil to nobody. Only allow players
      // the network knows about (Zander users or LuckPerms players).
      let recipientExists;
      try {
        recipientExists = await new UserGetter().hasJoined(raw, null, { includePlaceholders: false });
      } catch (err) {
        console.error(`[webstore] gift recipient lookup failed | user=${req.session.user.userId} recipient=${raw}:`, err.message);
        setBannerCookie("danger", "We couldn't check that player right now. Please try again shortly.", res);
        return res.redirect("/webstore");
      }
      if (!recipientExists) {
        console.log(`[webstore] gift refused, unknown recipient | user=${req.session.user.userId} recipient=${raw}`);
        setBannerCookie(
          "warning",
          `We couldn't find a player called "${raw}". They need to have joined the server before they can receive a gift.`,
          res
        );
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
