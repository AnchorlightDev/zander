import db from "./databaseController.js";
import { fetchStripePrices, resolveStripePriceAmount, formatPrice } from "./webstoreController.js";

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
  };
}

export async function getAllCatalogEntries() {
  const rows = await query(
    `SELECT id, stripePriceIds, displayName, description, imageUrl,
            category, categorySortOrder, sortOrder, perks, createdAt, updatedAt
     FROM rankCatalog
     ORDER BY categorySortOrder ASC, sortOrder ASC, displayName ASC`
  );
  return rows.map(rowToEntry);
}

export async function getCatalogEntry(id) {
  const rows = await query(
    `SELECT id, stripePriceIds, displayName, description, imageUrl,
            category, categorySortOrder, sortOrder, perks, createdAt, updatedAt
     FROM rankCatalog WHERE id = ?`,
    [id]
  );
  if (!rows.length) return null;
  return rowToEntry(rows[0]);
}

export async function createCatalogEntry({ stripePriceIds, displayName, description, imageUrl, category, categorySortOrder, sortOrder, perks }) {
  const result = await query(
    `INSERT INTO rankCatalog (stripePriceIds, displayName, description, imageUrl, category, categorySortOrder, sortOrder, perks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      JSON.stringify(Array.isArray(stripePriceIds) ? stripePriceIds : []),
      displayName,
      description || null,
      imageUrl || null,
      category || "Ranks",
      Number(categorySortOrder) || 0,
      Number(sortOrder) || 0,
      JSON.stringify(Array.isArray(perks) ? perks : []),
    ]
  );
  return result.insertId;
}

export async function updateCatalogEntry(id, { stripePriceIds, displayName, description, imageUrl, category, categorySortOrder, sortOrder, perks }) {
  await query(
    `UPDATE rankCatalog
     SET stripePriceIds = ?, displayName = ?, description = ?, imageUrl = ?,
         category = ?, categorySortOrder = ?, sortOrder = ?, perks = ?, updatedAt = NOW()
     WHERE id = ?`,
    [
      JSON.stringify(Array.isArray(stripePriceIds) ? stripePriceIds : []),
      displayName,
      description || null,
      imageUrl || null,
      category || "Ranks",
      Number(categorySortOrder) || 0,
      Number(sortOrder) || 0,
      JSON.stringify(Array.isArray(perks) ? perks : []),
      id,
    ]
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

  // Enrich entries and group by category
  const categoryMap = new Map();
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

    const pkg = { ...entry, prices };

    if (!categoryMap.has(entry.category)) {
      categoryMap.set(entry.category, { sortOrder: entry.categorySortOrder, packages: [] });
    }
    categoryMap.get(entry.category).packages.push(pkg);
  }

  return Array.from(categoryMap.entries())
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
    .map(([name, { packages }]) => ({ displayName: name, packages }));
}
