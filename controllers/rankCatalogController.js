import db from "./databaseController.js";
import { fetchStripePrices, resolveStripePriceAmount, formatPrice } from "./webstoreController.js";
import { groupByCategory } from "../lib/webstore/catalogVisibility.mjs";

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

function parseJsonArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function rowToEntry(r) {
  return {
    ...r,
    stripePriceIds: parseJsonArray(r.stripePriceIds),
    perks: parseJsonArray(r.perks),
    // TINYINT(1) arrives as 1/0; the rest of the app wants booleans.
    visible: r.visible === 1 || r.visible === true,
    categoryVisible: r.categoryVisible === 1 || r.categoryVisible === true,
  };
}

export async function getAllCatalogEntries() {
  const rows = await query(
    `SELECT rc.id, rc.stripePriceIds, rc.displayName, rc.description, rc.imageUrl,
            rc.visible, rc.categoryId, rc.sortOrder, rc.perks, rc.createdAt, rc.updatedAt,
            c.name AS categoryName, c.sortOrder AS categorySortOrder, c.visible AS categoryVisible
       FROM rankCatalog rc
       LEFT JOIN webstoreCategories c ON c.id = rc.categoryId
      ORDER BY c.sortOrder ASC, rc.sortOrder ASC, rc.displayName ASC`
  );
  return rows.map(rowToEntry);
}

export async function getCatalogEntry(id) {
  const rows = await query(
    `SELECT rc.id, rc.stripePriceIds, rc.displayName, rc.description, rc.imageUrl,
            rc.visible, rc.categoryId, rc.sortOrder, rc.perks, rc.createdAt, rc.updatedAt,
            c.name AS categoryName, c.sortOrder AS categorySortOrder, c.visible AS categoryVisible
       FROM rankCatalog rc
       LEFT JOIN webstoreCategories c ON c.id = rc.categoryId
      WHERE rc.id = ?`,
    [id]
  );
  if (!rows.length) return null;
  return rowToEntry(rows[0]);
}

export async function createCatalogEntry({ stripePriceIds, displayName, description, imageUrl, categoryId, sortOrder, perks, visible = true }) {
  const result = await query(
    `INSERT INTO rankCatalog (stripePriceIds, displayName, description, imageUrl, visible, categoryId, sortOrder, perks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      JSON.stringify(Array.isArray(stripePriceIds) ? stripePriceIds : []),
      displayName,
      description || null,
      imageUrl || null,
      visible ? 1 : 0,
      Number(categoryId) || null,
      Number(sortOrder) || 0,
      JSON.stringify(Array.isArray(perks) ? perks : []),
    ]
  );
  return result.insertId;
}

export async function updateCatalogEntry(id, { stripePriceIds, displayName, description, imageUrl, categoryId, sortOrder, perks, visible = true }) {
  await query(
    `UPDATE rankCatalog
     SET stripePriceIds = ?, displayName = ?, description = ?, imageUrl = ?,
         visible = ?, categoryId = ?, sortOrder = ?, perks = ?, updatedAt = NOW()
     WHERE id = ?`,
    [
      JSON.stringify(Array.isArray(stripePriceIds) ? stripePriceIds : []),
      displayName,
      description || null,
      imageUrl || null,
      visible ? 1 : 0,
      Number(categoryId) || null,
      Number(sortOrder) || 0,
      JSON.stringify(Array.isArray(perks) ? perks : []),
      id,
    ]
  );
}

/** Show/hide one product without touching the rest of the row. */
export async function setCatalogEntryVisibility(id, visible) {
  await query(
    `UPDATE rankCatalog SET visible = ?, updatedAt = NOW() WHERE id = ?`,
    [visible ? 1 : 0, id]
  );
}

export async function deleteCatalogEntry(id) {
  await query(`DELETE FROM rankCatalog WHERE id = ?`, [id]);
}

/**
 * Returns the catalog grouped by category, with Stripe price info merged in.
 * Each package has a `prices` array with one entry per linked Stripe price.
 * Used by the public /ranks page.
 */
export async function getRankCatalogForPublicPage(preferredCurrency = null) {
  const entries = await getAllCatalogEntries();
  if (!entries.length) return [];

  // Collect all needed Stripe price IDs across all entries
  const neededIds = new Set(entries.flatMap((e) => e.stripePriceIds));
  const priceMap = {};

  if (neededIds.size > 0) {
    try {
      const prices = await fetchStripePrices();
      for (const p of prices) {
        if (neededIds.has(p.id)) {
          const { amount, currency } = resolveStripePriceAmount(p, preferredCurrency);
          priceMap[p.id] = {
            stripePriceId: p.id,
            priceCents: amount,
            currency,
            purchaseType: p.type === "recurring" || p.recurring ? "subscription" : "one_time",
          };
        }
      }
    } catch (err) {
      console.error("[rankCatalog] Failed to fetch Stripe prices for public page:", err.message);
    }
  }

  // Enrich entries, then group. Hidden products -- and every product inside a
  // hidden category -- are dropped by groupByCategory's publicOnly pass.
  const enriched = [];
  for (const entry of entries) {
    const prices = entry.stripePriceIds
      .map((priceId) => {
        const info = priceMap[priceId];
        if (!info) return null;
        const badgeLabel = info.purchaseType === "subscription" ? "Monthly" : "One-time";
        return {
          stripePriceId: priceId,
          priceCents: info.priceCents,
          currency: info.currency,
          purchaseType: info.purchaseType,
          priceDisplay: formatPrice(info.priceCents, info.currency),
          badgeLabel,
        };
      })
      .filter(Boolean);

    enriched.push({ ...entry, prices });
  }

  return groupByCategory(enriched, { publicOnly: true })
    .map(({ displayName, packages }) => ({ displayName, packages }));
}
