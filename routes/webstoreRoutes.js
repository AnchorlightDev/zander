/**
 * webstoreRoutes.js
 *
 * Public-facing routes for the Webstore module.
 *
 * Routes:
 *   GET  /webstore              — storefront listing
 *   POST /webstore/checkout     — start a Stripe Checkout session
 *   GET  /webstore/thank-you    — post-payment landing page
 *   GET  /webstore/history      — authenticated purchase history
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
  createStripeCheckoutSession,
  findWebstoreItem,
  formatPrice,
  getPurchaseHistory,
  getPurchaseHistoryCount,
  getReceivedGifts,
  getReceivedGiftsCount,
  getWebstoreItems,
  preferredCurrencyFromLocale,
} from "../controllers/webstoreController.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a best-effort locale from the Accept-Language header. */
function parseLocale(req) {
  const header = req.headers["accept-language"];
  if (typeof header !== "string") return "en-US";
  return header.split(",")[0].trim() || "en-US";
}

/** Validate a Minecraft username: 1-16 alphanumeric / underscore characters. */
function isValidMinecraftUsername(name) {
  return typeof name === "string" && /^[A-Za-z0-9_]{1,16}$/.test(name);
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
    let itemsError = false;
    try {
      items = (await getWebstoreItems(preferredCurrency)).map((item) => ({
        ...item,
        priceDisplay: formatPrice(item.priceCents, item.currency, locale),
        purchaseLabel: item.purchaseType === "subscription" ? "Subscribe" : "Buy Now",
        badgeLabel: item.purchaseType === "subscription" ? "Monthly" : "One-time",
      }));
      console.log(`[webstore] loaded ${items.length} item(s) for storefront`);
    } catch (err) {
      console.error("[webstore] Failed to load items:", err.message);
      itemsError = true;
    }

    return res.view("modules/webstore/index", {
      pageTitle: "Webstore",
      pageDescription: `Support ${config.siteConfiguration.siteName} with ranks, perks, and more.`,
      config,
      req,
      features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      items,
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

    // --- Determine recipient ---
    const purchaseFor = typeof req.body?.purchaseFor === "string"
      ? req.body.purchaseFor.trim()
      : "self";

    let recipientUsername;
    let isGift = false;

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
      });
      console.log(`[webstore] Stripe session created | sessionId=${session.id} user=${req.session.user.userId} item=${item.slug} recipient=${recipientUsername} isGift=${isGift}`);
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
      });
      console.log(`[webstore] pending purchase recorded | sessionId=${session.id} user=${req.session.user.userId} item=${item.slug}`);
    } catch (err) {
      // Log but don't block — the webhook can still look up the session ID
      console.error("[webstore] createPendingPurchase error:", err.message);
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

    try {
      [purchases, totalCount, receivedGifts, receivedGiftsTotal] = await Promise.all([
        getPurchaseHistory(userId, limit, offset),
        getPurchaseHistoryCount(userId),
        minecraftUsername ? getReceivedGifts(minecraftUsername, limit, giftOffset) : [],
        minecraftUsername ? getReceivedGiftsCount(minecraftUsername) : 0,
      ]);
      console.log(`[webstore] purchase history loaded | user=${userId} purchases=${totalCount} receivedGifts=${receivedGiftsTotal}`);
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
    });
  });

  // -------------------------------------------------------------------------
  // GET /give — legacy entry point now redirected to the Finance Centre support section
  // -------------------------------------------------------------------------
  app.get("/give", async function (req, res) {
    return res.redirect(301, "/finance#support");
  });
}
