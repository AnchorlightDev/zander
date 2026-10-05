/**
 * lib/homepageForum.js
 *
 * Which forum categories feed the homepage's "Latest from the forums"
 * section. No DB import, so it is unit-testable.
 */

/**
 * The category ids to draw homepage posts from.
 *
 * `categoryData` is getCategoriesForUser() for this visitor, so its `flat`
 * list holds only categories they can see. With no slug configured that is
 * the whole list. With one, it is that category plus its subcategories the
 * visitor can see -- and nothing if the category is hidden from them or does
 * not exist, rather than falling back to posts from somewhere else.
 */
export function homepageCategoryIds(categoryData, slug = "") {
  const flat = categoryData?.flat || [];
  const wanted = String(slug || "").trim().toLowerCase();
  if (!wanted) return flat.map((c) => c.categoryId);

  const root = flat.find((c) => String(c.slug).toLowerCase() === wanted);
  if (!root) return [];

  const ids = [];
  const walk = (node) => {
    if (node.isAccessible !== false) ids.push(node.categoryId);
    (node.children || []).forEach(walk);
  };
  walk(root);
  return ids;
}
