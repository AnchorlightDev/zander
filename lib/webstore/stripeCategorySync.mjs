/**
 * lib/webstore/stripeCategorySync.mjs
 *
 * The rule for keeping each storefront product's category in step with its
 * Stripe `metadata.category`, without ever treading on a category an admin set
 * by hand. Pure (no DB, no network) so the rule is testable on its own -- the
 * controller feeds it the current settings and the resolved category ids and
 * applies whatever changes it returns.
 *
 * "Stripe seeds, dashboard overrides":
 *   - A product the admin categorised in the dashboard (categoryManual) is left
 *     exactly as it is, including an explicit "no category".
 *   - Every other product follows its Stripe metadata: assigned to the seeded
 *     category, moved when that metadata changes, and cleared when it is removed.
 *   - A product that has never been categorised and has no Stripe category stays
 *     untouched, so no empty settings rows are created for it.
 */

/**
 * @param {Array<{ stripePriceId: string, stripeCategory?: string|null }>} items
 *        the live Stripe item list (from getWebstoreItems)
 * @param {Map<string, { categoryId: number|null, categoryManual: boolean }>} settingsByPrice
 *        current webstoreItemSettings, keyed by Stripe price id
 * @param {Map<string, number>} keyToCategoryId
 *        resolved `stripeKey -> categoryId` (from ensureCategoriesForStripeKeys)
 * @returns {Array<{ stripePriceId: string, categoryId: number|null }>}
 *          the minimal set of category assignments to write
 */
export function planStripeCategorySync(items, settingsByPrice, keyToCategoryId) {
  const settings = settingsByPrice instanceof Map ? settingsByPrice : new Map();
  const keys = keyToCategoryId instanceof Map ? keyToCategoryId : new Map();
  const changes = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.stripePriceId) continue;
    const priceId = String(item.stripePriceId);
    const setting = settings.get(priceId) || null;

    // A manual choice is sacred -- never overwrite it, not even "no category".
    if (setting && setting.categoryManual) continue;

    const key = typeof item.stripeCategory === "string" ? item.stripeCategory.trim() : "";
    let desiredCategoryId;
    if (key) {
      // The category should always have been ensured first; if a handle somehow
      // did not resolve, leave the product alone rather than wiping its category
      // on a transient miss.
      if (!keys.has(key)) continue;
      desiredCategoryId = keys.get(key);
    } else {
      desiredCategoryId = null;
    }

    const currentCategoryId = setting ? setting.categoryId ?? null : null;

    // Never create an empty settings row: a product with nothing to say stays
    // out of the table entirely, exactly as before.
    if (!setting && desiredCategoryId === null) continue;
    if (currentCategoryId === desiredCategoryId) continue;

    changes.push({ stripePriceId: priceId, categoryId: desiredCategoryId });
  }

  return changes;
}
