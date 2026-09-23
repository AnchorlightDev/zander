/**
 * lib/webstore/catalogVisibility.mjs
 *
 * The rules deciding what the public /ranks page may show, and how the catalog
 * is grouped into categories.
 *
 * Imports nothing -- no database, no config -- so the rules can be tested
 * directly. Getting this wrong leaks an unfinished product onto a public page,
 * which is not the kind of bug you want to find out about from a customer.
 *
 * Two flags decide a product's fate: its own `visible`, and the `visible` of
 * the category holding it. They are ANDed, so hiding a category stages the
 * whole section at once without touching each product.
 */

/**
 * MySQL hands TINYINT(1) back as 1/0, a driver may give true/false, and a row
 * selected before this column existed gives undefined. Absent means "not
 * hidden" -- the column is NOT NULL DEFAULT 1, so a query that forgets to
 * select it must not blank the store.
 */
function flagIsSet(value) {
  if (value === undefined || value === null) return true;
  return !(value === 0 || value === false || value === "0" || value === "");
}

/** Is this product itself published? Ignores the category it sits in. */
export function isProductVisible(entry) {
  return flagIsSet(entry?.visible);
}

/** Is the category holding this product published? */
export function isCategoryVisible(entry) {
  return flagIsSet(entry?.categoryVisible);
}

/**
 * May the public see this product? Both the product and its category must be
 * visible.
 */
export function isPubliclyVisible(entry) {
  return isProductVisible(entry) && isCategoryVisible(entry);
}

function compareCategories(a, b) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return String(a.displayName).localeCompare(String(b.displayName));
}

function compareProducts(a, b) {
  const ao = Number(a.sortOrder) || 0;
  const bo = Number(b.sortOrder) || 0;
  if (ao !== bo) return ao - bo;
  return String(a.displayName || "").localeCompare(String(b.displayName || ""));
}

/**
 * Group catalog rows into categories.
 *
 * @param {Array<object>} entries  rows carrying categoryId/categoryName/
 *                                 categoryVisible/categorySortOrder
 * @param {object}  [options]
 * @param {boolean} [options.publicOnly=false]  drop anything the public may not
 *                  see, and drop categories left with no products
 * @returns {Array<{ id: number|null, displayName: string, visible: boolean,
 *                   sortOrder: number, packages: Array<object> }>}
 *
 * The `displayName` + `packages` shape is what views/ranks.ejs and
 * lib/seo/rankSchema.js already consume -- do not rename them without changing
 * both.
 */
export function groupByCategory(entries, { publicOnly = false } = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const byId = new Map();

  for (const entry of rows) {
    if (!entry) continue;
    if (publicOnly && !isPubliclyVisible(entry)) continue;

    // Rows with no category still have to land somewhere rather than be
    // silently dropped; the migration backfills these, but a row inserted by
    // hand could still arrive without one.
    const key = entry.categoryId ?? `name:${entry.categoryName ?? "Uncategorised"}`;

    if (!byId.has(key)) {
      byId.set(key, {
        id: entry.categoryId ?? null,
        displayName: entry.categoryName ?? "Uncategorised",
        visible: isCategoryVisible(entry),
        sortOrder: Number(entry.categorySortOrder) || 0,
        packages: [],
      });
    }
    byId.get(key).packages.push(entry);
  }

  const groups = [...byId.values()];
  for (const group of groups) group.packages.sort(compareProducts);
  return groups.sort(compareCategories);
}

/**
 * Merge in categories that currently hold no products.
 *
 * The dashboard has to list an empty category -- you cannot put the first
 * product into one you cannot see. The public page never calls this.
 */
export function withEmptyCategories(groups, categories) {
  const present = new Set(groups.map((g) => g.id).filter((id) => id !== null));
  const extra = (Array.isArray(categories) ? categories : [])
    .filter((c) => c && !present.has(c.id))
    .map((c) => ({
      id: c.id,
      displayName: c.name,
      visible: flagIsSet(c.visible),
      sortOrder: Number(c.sortOrder) || 0,
      packages: [],
    }));

  return [...groups, ...extra].sort(compareCategories);
}
