import { hasPermission, isFeatureWebRouteEnabled } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  getAllCatalogEntries,
  getCatalogEntry,
  createCatalogEntry,
  updateCatalogEntry,
  deleteCatalogEntry,
  setCatalogEntryVisibility,
} from "../../controllers/rankCatalogController.js";
import { getAllCategories } from "../../controllers/webstoreCategoryController.js";
import { groupByCategory, withEmptyCategories } from "../../lib/webstore/catalogVisibility.mjs";
import { fetchStripePrices } from "../../controllers/webstoreController.js";

async function getStripeOptions() {
  try {
    const prices = await fetchStripePrices();
    return prices
      .filter((p) => p.active && typeof p.product === "object" && p.product?.active)
      .map((p) => ({
        id: p.id,
        label: `${p.product?.name || p.id} — ${p.nickname || p.id} (${p.type === "recurring" || p.recurring ? "subscription" : "one-time"})`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

function parseJsonBody(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) return parsed.map(String).filter((s) => s.trim());
  } catch {}
  return [];
}

function parsePerkGroups(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g) => g && typeof g === "object");
  } catch {}
  return [];
}

export default function dashboardRankCatalogRoute(app, config, db, features, lang) {

  // ── List ──────────────────────────────────────────────────────────────────
  app.get("/dashboard/rank-catalog", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    const [entries, categories, announcementWeb] = await Promise.all([
      getAllCatalogEntries(),
      getAllCategories(),
      getWebAnnouncement(),
    ]);

    // Not publicOnly: the dashboard has to show hidden products, and
    // withEmptyCategories keeps a brand-new empty category on screen so you can
    // put the first product into it.
    const groups = withEmptyCategories(groupByCategory(entries), categories);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/rank-catalog/index", {
        pageTitle: "Rank Catalog",
        config, features, req, announcementWeb,
        entries,
        categories,
        categoryGroups: groups.map((g) => ({
          id: g.id,
          name: g.displayName,
          visible: g.visible,
          items: g.packages,
        })),
      })
    );
  });

  // ── Create GET ────────────────────────────────────────────────────────────
  app.get("/dashboard/rank-catalog/create", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    const [stripeOptions, categories, announcementWeb] = await Promise.all([
      getStripeOptions(),
      getAllCategories(),
      getWebAnnouncement(),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/rank-catalog/form", {
        pageTitle: "Create Rank Entry",
        config, features, req, announcementWeb,
        entry: null,
        stripeOptions,
        categories,
        formAction: "/dashboard/rank-catalog/create",
      })
    );
  });

  // ── Create POST ───────────────────────────────────────────────────────────
  app.post("/dashboard/rank-catalog/create", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    const body = req.body || {};
    if (!body.displayName?.trim()) {
      return res.redirect("/dashboard/rank-catalog/create");
    }

    try {
      await createCatalogEntry({
        stripePriceIds: parseJsonBody(body.stripePriceIds),
        displayName: body.displayName.trim(),
        description: body.description?.trim() || null,
        imageUrl: body.imageUrl?.trim() || null,
        categoryId: body.categoryId,
        sortOrder: body.sortOrder,
        perks: parsePerkGroups(body.perks),
        visible: body.visible === "on" || body.visible === "1" || body.visible === "true",
      });
      return res.redirect("/dashboard/rank-catalog");
    } catch (err) {
      console.error("[rank-catalog] create error:", err);
      return res.redirect("/dashboard/rank-catalog/create");
    }
  });

  // ── Edit GET ──────────────────────────────────────────────────────────────
  app.get("/dashboard/rank-catalog/:id/edit", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    const [entry, stripeOptions, categories, announcementWeb] = await Promise.all([
      getCatalogEntry(req.params.id),
      getStripeOptions(),
      getAllCategories(),
      getWebAnnouncement(),
    ]);

    if (!entry) return res.status(404).redirect("/dashboard/rank-catalog");

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/rank-catalog/form", {
        pageTitle: `Edit — ${entry.displayName}`,
        config, features, req, announcementWeb,
        entry,
        stripeOptions,
        categories,
        formAction: `/dashboard/rank-catalog/${entry.id}/edit`,
      })
    );
  });

  // ── Edit POST ─────────────────────────────────────────────────────────────
  app.post("/dashboard/rank-catalog/:id/edit", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    const body = req.body || {};
    if (!body.displayName?.trim()) {
      return res.redirect(`/dashboard/rank-catalog/${req.params.id}/edit`);
    }

    try {
      await updateCatalogEntry(req.params.id, {
        stripePriceIds: parseJsonBody(body.stripePriceIds),
        displayName: body.displayName.trim(),
        description: body.description?.trim() || null,
        imageUrl: body.imageUrl?.trim() || null,
        categoryId: body.categoryId,
        sortOrder: body.sortOrder,
        perks: parsePerkGroups(body.perks),
        visible: body.visible === "on" || body.visible === "1" || body.visible === "true",
      });
      return res.redirect("/dashboard/rank-catalog");
    } catch (err) {
      console.error("[rank-catalog] edit error:", err);
      return res.redirect(`/dashboard/rank-catalog/${req.params.id}/edit`);
    }
  });

  // ── Show / hide POST ──────────────────────────────────────────────────────
  // A one-click toggle from the list, so publishing does not mean opening the
  // full edit form and re-submitting every field.
  app.post("/dashboard/rank-catalog/:id/visibility", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    try {
      const visible = (req.body || {}).visible;
      await setCatalogEntryVisibility(
        req.params.id,
        visible === "on" || visible === "1" || visible === "true"
      );
    } catch (err) {
      console.error("[rank-catalog] visibility error:", err);
    }
    return res.redirect("/dashboard/rank-catalog");
  });

  // ── Delete POST ───────────────────────────────────────────────────────────
  app.post("/dashboard/rank-catalog/:id/delete", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    try {
      await deleteCatalogEntry(req.params.id);
    } catch (err) {
      console.error("[rank-catalog] delete error:", err);
    }
    return res.redirect("/dashboard/rank-catalog");
  });
}
