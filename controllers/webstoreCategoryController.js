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
  const rows = await query(
    `SELECT c.id, c.name, c.sortOrder, c.visible, c.createdAt, c.updatedAt,
            COUNT(rc.id) AS productCount,
            SUM(CASE WHEN rc.visible = 1 THEN 1 ELSE 0 END) AS visibleProductCount
       FROM webstoreCategories c
       LEFT JOIN rankCatalog rc ON rc.categoryId = c.id
      GROUP BY c.id, c.name, c.sortOrder, c.visible, c.createdAt, c.updatedAt
      ORDER BY c.sortOrder ASC, c.name ASC`
  );
  return rows.map((r) => ({
    ...rowToCategory(r),
    productCount: Number(r.productCount) || 0,
    visibleProductCount: Number(r.visibleProductCount) || 0,
  }));
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
  const [{ productCount }] = await query(
    `SELECT COUNT(*) AS productCount FROM rankCatalog WHERE categoryId = ?`,
    [id]
  );
  const count = Number(productCount) || 0;
  if (count > 0) throw new CategoryInUseError(count);

  await query(`DELETE FROM webstoreCategories WHERE id = ?`, [id]);
}

/** Move every product in one category to another, so the first can be deleted. */
export async function reassignProducts(fromCategoryId, toCategoryId) {
  const result = await query(
    `UPDATE rankCatalog SET categoryId = ?, updatedAt = NOW() WHERE categoryId = ?`,
    [toCategoryId, fromCategoryId]
  );
  return result.affectedRows || 0;
}
