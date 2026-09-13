import { hasPermission, isFeatureWebRouteEnabled } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  getAllCatalogEntries,
  getCatalogEntry,
  createCatalogEntry,
  updateCatalogEntry,
  deleteCatalogEntry,
} from "../../controllers/rankCatalogController.js";
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

    const [entries, announcementWeb] = await Promise.all([
      getAllCatalogEntries(),
      getWebAnnouncement(),
    ]);

    const categoryMap = new Map();
    for (const e of entries) {
      if (!categoryMap.has(e.category)) categoryMap.set(e.category, []);
      categoryMap.get(e.category).push(e);
    }

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/rank-catalog/index", {
        pageTitle: "Rank Catalog",
        config, features, req, announcementWeb,
        entries,
        categoryGroups: Array.from(categoryMap.entries()).map(([name, items]) => ({ name, items })),
      })
    );
  });

  // ── Create GET ────────────────────────────────────────────────────────────
  app.get("/dashboard/rank-catalog/create", async (req, res) => {
    if (!await isFeatureWebRouteEnabled(app, features.webstore, req, res, features)) return;
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;

    const [stripeOptions, announcementWeb] = await Promise.all([
      getStripeOptions(),
      getWebAnnouncement(),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/rank-catalog/form", {
        pageTitle: "Create Rank Entry",
        config, features, req, announcementWeb,
        entry: null,
        stripeOptions,
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
        category: body.category?.trim() || "Ranks",
        categorySortOrder: body.categorySortOrder,
        sortOrder: body.sortOrder,
        perks: parsePerkGroups(body.perks),
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

    const [entry, stripeOptions, announcementWeb] = await Promise.all([
      getCatalogEntry(req.params.id),
      getStripeOptions(),
      getWebAnnouncement(),
    ]);

    if (!entry) return res.status(404).redirect("/dashboard/rank-catalog");

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/rank-catalog/form", {
        pageTitle: `Edit — ${entry.displayName}`,
        config, features, req, announcementWeb,
        entry,
        stripeOptions,
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
        category: body.category?.trim() || "Ranks",
        categorySortOrder: body.categorySortOrder,
        sortOrder: body.sortOrder,
        perks: parsePerkGroups(body.perks),
      });
      return res.redirect("/dashboard/rank-catalog");
    } catch (err) {
      console.error("[rank-catalog] edit error:", err);
      return res.redirect(`/dashboard/rank-catalog/${req.params.id}/edit`);
    }
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
