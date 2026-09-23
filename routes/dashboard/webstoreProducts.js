/**
 * routes/dashboard/webstoreProducts.js
 *
 * Category and visibility for the /webstore storefront's products.
 *
 * The storefront's list comes live from Stripe, so this page does not create or
 * delete products -- that happens in Stripe. It attaches the two things Stripe
 * has no opinion about: which category a product sits in, and whether the
 * public may see it.
 *
 * Products with no row in webstoreItemSettings are listed here as visible and
 * uncategorised, which is exactly how they behave.
 */

import { hasPermission, isFeatureWebRouteEnabled, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { getWebstoreItems } from "../../controllers/webstoreController.js";
import { getAllCategories } from "../../controllers/webstoreCategoryController.js";
import {
  getAllItemSettings,
  upsertItemSettings,
  setItemVisibility,
} from "../../controllers/webstoreItemSettingsController.js";
import { applyItemSettings, groupByCategory } from "../../lib/webstore/catalogVisibility.mjs";

const LIST_PATH = "/dashboard/webstore/products";

function checked(value) {
  return value === "on" || value === "1" || value === "true";
}

export default function dashboardWebstoreProductsRoute(app, config, db, features, lang) {

  async function guard(req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return false;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return false;
    return true;
  }

  // ── List ──────────────────────────────────────────────────────────────────
  app.get(LIST_PATH, async (req, res) => {
    if (!await guard(req, res)) return;

    // Categories and the announcement are wanted even when Stripe is down, so
    // the page can still explain itself; only the product list is conditional.
    const [categories, announcementWeb] = await Promise.all([
      getAllCategories().catch(() => []),
      getWebAnnouncement(),
    ]);

    let products = [];
    let groups = [];
    let stripeError = false;

    try {
      const [items, settings] = await Promise.all([
        getWebstoreItems(),
        getAllItemSettings(),
      ]);
      products = applyItemSettings(items, settings, categories);
      // Not publicOnly -- this page exists to show what is hidden.
      groups = groupByCategory(products);
    } catch (err) {
      console.error("[webstore-products] failed to load products:", err.message);
      stripeError = true;
    }

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/webstore/products", {
        pageTitle: "Storefront Products",
        config, features, req, announcementWeb,
        products,
        groups,
        categories,
        stripeError,
      })
    );
  });

  // ── Save one product's settings ───────────────────────────────────────────
  app.post(`${LIST_PATH}/save`, async (req, res) => {
    if (!await guard(req, res)) return;

    const body = req.body || {};
    const stripePriceId = String(body.stripePriceId || "").trim();
    if (!stripePriceId) {
      setBannerCookie("danger", "Missing product reference.", res);
      return res.redirect(LIST_PATH);
    }

    try {
      await upsertItemSettings(stripePriceId, {
        categoryId: body.categoryId === "" ? null : body.categoryId,
        visible: checked(body.visible),
        sortOrder: body.sortOrder,
      });
      setBannerCookie("success", "Product updated.", res);
    } catch (err) {
      console.error("[webstore-products] save error:", err);
      setBannerCookie("danger", "Could not save that product.", res);
    }
    return res.redirect(LIST_PATH);
  });

  // ── Show / hide ───────────────────────────────────────────────────────────
  app.post(`${LIST_PATH}/visibility`, async (req, res) => {
    if (!await guard(req, res)) return;

    const body = req.body || {};
    const stripePriceId = String(body.stripePriceId || "").trim();
    if (!stripePriceId) {
      setBannerCookie("danger", "Missing product reference.", res);
      return res.redirect(LIST_PATH);
    }

    try {
      const visible = checked(body.visible);
      await setItemVisibility(stripePriceId, visible);
      setBannerCookie(
        "success",
        `Product is now ${visible ? "visible on" : "hidden from"} the storefront.`,
        res
      );
    } catch (err) {
      console.error("[webstore-products] visibility error:", err);
      setBannerCookie("danger", "Could not change that product's visibility.", res);
    }
    return res.redirect(LIST_PATH);
  });
}
