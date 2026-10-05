/**
 * webstoreItemSettingsController.js
 *
 * Local settings for the /webstore storefront's products.
 *
 * That storefront builds its list live from Stripe, so there is no local row
 * per product to hang a category or a visibility flag on. This table supplies
 * them, keyed by Stripe price ID -- the same approach webstoreStripeCommands
 * already uses to attach command templates to a price.
 *
 * A price with no row here behaves exactly as it did before the table existed:
 * visible, and uncategorised.
 *
 * Raw SQL through the mysql2 pool, matching the controllers either side of it.
 */

import db from "./databaseController.js";

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

function rowToSetting(r) {
  return { ...r, visible: r.visible === 1 || r.visible === true };
}

/** Every settings row. Callers index these by stripePriceId themselves. */
export async function getAllItemSettings() {
  const rows = await query(
    `SELECT stripePriceId, categoryId, visible, sortOrder, createdAt, updatedAt
       FROM webstoreItemSettings`
  );
  return rows.map(rowToSetting);
}

export async function getItemSettings(stripePriceId) {
  const rows = await query(
    `SELECT stripePriceId, categoryId, visible, sortOrder, createdAt, updatedAt
       FROM webstoreItemSettings WHERE stripePriceId = ?`,
    [stripePriceId]
  );
  return rows.length ? rowToSetting(rows[0]) : null;
}

/**
 * Create or update the settings for one Stripe price.
 *
 * Upsert rather than insert-then-update: the row only comes into existence the
 * first time somebody categorises or hides a product, so almost every call for
 * a given price is the first one.
 */
export async function upsertItemSettings(stripePriceId, { categoryId, visible = true, sortOrder = 0 }) {
  await query(
    `INSERT INTO webstoreItemSettings (stripePriceId, categoryId, visible, sortOrder)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       categoryId = VALUES(categoryId),
       visible    = VALUES(visible),
       sortOrder  = VALUES(sortOrder),
       updatedAt  = NOW()`,
    [
      String(stripePriceId),
      categoryId === null || categoryId === undefined || categoryId === "" ? null : Number(categoryId),
      visible ? 1 : 0,
      Number(sortOrder) || 0,
    ]
  );
}

/** Show/hide one product without disturbing its category or order. */
export async function setItemVisibility(stripePriceId, visible) {
  await query(
    `INSERT INTO webstoreItemSettings (stripePriceId, visible)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE visible = VALUES(visible), updatedAt = NOW()`,
    [String(stripePriceId), visible ? 1 : 0]
  );
}

/** How many storefront products a category holds, for the delete guard. */
export async function countItemsInCategory(categoryId) {
  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM webstoreItemSettings WHERE categoryId = ?`,
    [categoryId]
  );
  return Number(total) || 0;
}

/** Move every storefront product in one category to another. */
export async function reassignItems(fromCategoryId, toCategoryId) {
  const result = await query(
    `UPDATE webstoreItemSettings SET categoryId = ?, updatedAt = NOW() WHERE categoryId = ?`,
    [toCategoryId, fromCategoryId]
  );
  return result.affectedRows || 0;
}

/**
 * Drop settings rows whose Stripe price no longer exists.
 *
 * Prices are deleted in Stripe, not here, so rows can outlive them. Harmless --
 * nothing joins on them -- but they would otherwise keep a category looking
 * occupied and block deleting it.
 */
export async function pruneOrphanedSettings(livePriceIds) {
  const ids = (Array.isArray(livePriceIds) ? livePriceIds : []).map(String);
  if (!ids.length) return 0;

  const placeholders = ids.map(() => "?").join(",");
  const result = await query(
    `DELETE FROM webstoreItemSettings WHERE stripePriceId NOT IN (${placeholders})`,
    ids
  );
  return result.affectedRows || 0;
}
