/**
 * webstoreCategoryController.js
 *
 * Categories for the webstore catalog (the /ranks page and its dashboard).
 *
 * Raw SQL through the mysql2 pool, matching rankCatalogController.js which
 * owns the products that point at these rows.
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

/** Thrown rather than letting the foreign key surface a driver error. */
export class CategoryInUseError extends Error {
  constructor(productCount) {
    super(
      `Category still holds ${productCount} product${productCount === 1 ? "" : "s"}. ` +
      `Move them to another category before deleting it.`
    );
    this.name = "CategoryInUseError";
    this.productCount = productCount;
  }
}

/** Thrown when a name collides with the UNIQUE index. */
export class DuplicateCategoryError extends Error {
  constructor(name) {
    super(`A category named "${name}" already exists.`);
    this.name = "DuplicateCategoryError";
  }
}

function rowToCategory(r) {
  return { ...r, visible: r.visible === 1 || r.visible === true };
}

/** Every category, in the order the store presents them. */
export async function getAllCategories() {
  const rows = await query(
    `SELECT id, name, sortOrder, visible, createdAt, updatedAt
       FROM webstoreCategories
      ORDER BY sortOrder ASC, name ASC`
  );
  return rows.map(rowToCategory);
}

/** Every category plus how many products each holds, for the dashboard list. */
export async function getAllCategoriesWithCounts() {
  // Two independent things live in a category: rank catalog entries (/ranks)
  // and storefront products (/webstore). Counted separately rather than in one
  // join, which would multiply the rows together.
  const rows = await query(
    `SELECT c.id, c.name, c.sortOrder, c.visible, c.createdAt, c.updatedAt,
            (SELECT COUNT(*) FROM rankCatalog rc WHERE rc.categoryId = c.id)
              AS rankCount,
            (SELECT COUNT(*) FROM rankCatalog rc WHERE rc.categoryId = c.id AND rc.visible = 1)
              AS visibleRankCount,
            (SELECT COUNT(*) FROM webstoreItemSettings s WHERE s.categoryId = c.id)
              AS itemCount,
            (SELECT COUNT(*) FROM webstoreItemSettings s WHERE s.categoryId = c.id AND s.visible = 1)
              AS visibleItemCount
       FROM webstoreCategories c
      ORDER BY c.sortOrder ASC, c.name ASC`
  );
  return rows.map((r) => {
    const rankCount = Number(r.rankCount) || 0;
    const itemCount = Number(r.itemCount) || 0;
    return {
      ...rowToCategory(r),
      rankCount,
      itemCount,
      productCount: rankCount + itemCount,
      visibleProductCount: (Number(r.visibleRankCount) || 0) + (Number(r.visibleItemCount) || 0),
    };
  });
}

export async function getCategory(id) {
  const rows = await query(
    `SELECT id, name, sortOrder, visible, createdAt, updatedAt
       FROM webstoreCategories WHERE id = ?`,
    [id]
  );
  return rows.length ? rowToCategory(rows[0]) : null;
}

export async function createCategory({ name, sortOrder = 0, visible = true }) {
  try {
    const result = await query(
      `INSERT INTO webstoreCategories (name, sortOrder, visible) VALUES (?, ?, ?)`,
      [String(name).trim(), Number(sortOrder) || 0, visible ? 1 : 0]
    );
    return result.insertId;
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") throw new DuplicateCategoryError(name);
    throw err;
  }
}

export async function updateCategory(id, { name, sortOrder = 0, visible = true }) {
  try {
    await query(
      `UPDATE webstoreCategories
          SET name = ?, sortOrder = ?, visible = ?, updatedAt = NOW()
        WHERE id = ?`,
      [String(name).trim(), Number(sortOrder) || 0, visible ? 1 : 0, id]
    );
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") throw new DuplicateCategoryError(name);
    throw err;
  }
}

/** Show/hide without touching the rest of the row. */
export async function setCategoryVisibility(id, visible) {
  await query(
    `UPDATE webstoreCategories SET visible = ?, updatedAt = NOW() WHERE id = ?`,
    [visible ? 1 : 0, id]
  );
}

/**
 * Delete a category.
 *
 * Refuses while products still point at it. The foreign key would refuse too,
 * but as an opaque driver error -- this says which category and how many
 * products, so the dashboard can show something useful.
 */
export async function deleteCategory(id) {
  const [{ total }] = await query(
    `SELECT
        (SELECT COUNT(*) FROM rankCatalog WHERE categoryId = ?)
      + (SELECT COUNT(*) FROM webstoreItemSettings WHERE categoryId = ?) AS total`,
    [id, id]
  );
  const count = Number(total) || 0;
  if (count > 0) throw new CategoryInUseError(count);

  await query(`DELETE FROM webstoreCategories WHERE id = ?`, [id]);
}

/**
 * Move everything in one category to another, so the first can be deleted.
 * Covers both rank catalog entries and storefront products.
 */
export async function reassignProducts(fromCategoryId, toCategoryId) {
  const ranks = await query(
    `UPDATE rankCatalog SET categoryId = ?, updatedAt = NOW() WHERE categoryId = ?`,
    [toCategoryId, fromCategoryId]
  );
  const items = await query(
    `UPDATE webstoreItemSettings SET categoryId = ?, updatedAt = NOW() WHERE categoryId = ?`,
    [toCategoryId, fromCategoryId]
  );
  return (ranks.affectedRows || 0) + (items.affectedRows || 0);
}
