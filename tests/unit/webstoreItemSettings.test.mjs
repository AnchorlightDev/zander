/**
 * tests/unit/webstoreItemSettings.test.mjs
 *
 * Attaching local category/visibility settings to the live Stripe product list
 * that /webstore builds itself from.
 *
 * The important property is that a product Stripe knows about but this app has
 * never been told anything about keeps working exactly as it did before the
 * settings table existed. Anything else means shipping the migration silently
 * empties somebody's storefront.
 */

import { describe, expect, it } from "vitest";
import {
  applyItemSettings,
  groupByCategory,
  isPubliclyVisible,
} from "../../lib/webstore/catalogVisibility.mjs";

/** Shaped like what getWebstoreItems() returns. */
function stripeItem(overrides = {}) {
  return {
    slug: "price_abc",
    stripePriceId: "price_abc",
    displayName: "Knight Rank",
    priceCents: 500,
    currency: "aud",
    purchaseType: "one_time",
    sortKey: 0,
    ...overrides,
  };
}

const CATEGORIES = [
  { id: 1, name: "Ranks", sortOrder: 0, visible: 1 },
  { id: 2, name: "Cosmetics", sortOrder: 1, visible: 1 },
  { id: 3, name: "Staged", sortOrder: 2, visible: 0 },
];

describe("applyItemSettings", () => {
  it("leaves a product with no settings row exactly as it behaved before", () => {
    // This is the upgrade path: the table is empty the moment the migration
    // lands, and nothing may disappear from the storefront because of it.
    const [item] = applyItemSettings([stripeItem()], [], CATEGORIES);

    expect(item.visible).toBe(true);
    expect(item.categoryId).toBeNull();
    expect(item.categoryName).toBeNull();
    expect(item.categoryVisible).toBe(true);
    expect(isPubliclyVisible(item)).toBe(true);
  });

  it("attaches the category named by the settings row", () => {
    const [item] = applyItemSettings(
      [stripeItem()],
      [{ stripePriceId: "price_abc", categoryId: 2, visible: 1, sortOrder: 0 }],
      CATEGORIES
    );

    expect(item.categoryId).toBe(2);
    expect(item.categoryName).toBe("Cosmetics");
    expect(item.categorySortOrder).toBe(1);
  });

  it("applies a hidden product's flag", () => {
    const [item] = applyItemSettings(
      [stripeItem()],
      [{ stripePriceId: "price_abc", categoryId: 1, visible: 0, sortOrder: 0 }],
      CATEGORIES
    );

    expect(item.visible).toBe(false);
    expect(isPubliclyVisible(item)).toBe(false);
  });

  it("hides a product sitting in a hidden category, though the product is visible", () => {
    const [item] = applyItemSettings(
      [stripeItem()],
      [{ stripePriceId: "price_abc", categoryId: 3, visible: 1, sortOrder: 0 }],
      CATEGORIES
    );

    expect(item.visible).toBe(true);
    expect(item.categoryVisible).toBe(false);
    expect(isPubliclyVisible(item)).toBe(false);
  });

  it("falls back to the Stripe metadata order when no local order is set", () => {
    const [item] = applyItemSettings([stripeItem({ sortKey: 7 })], [], CATEGORIES);
    expect(item.sortOrder).toBe(7);
  });

  it("prefers the local order over the Stripe one", () => {
    const [item] = applyItemSettings(
      [stripeItem({ sortKey: 7 })],
      [{ stripePriceId: "price_abc", categoryId: 1, visible: 1, sortOrder: 2 }],
      CATEGORIES
    );

    expect(item.sortOrder).toBe(2);
  });

  it("treats a settings row pointing at a category that no longer exists as uncategorised", () => {
    const [item] = applyItemSettings(
      [stripeItem()],
      [{ stripePriceId: "price_abc", categoryId: 99, visible: 1, sortOrder: 0 }],
      CATEGORIES
    );

    expect(item.categoryId).toBeNull();
    expect(item.categoryVisible).toBe(true);
    expect(isPubliclyVisible(item)).toBe(true);
  });

  it("ignores settings rows for prices that are not in the list", () => {
    const items = applyItemSettings(
      [stripeItem({ stripePriceId: "price_abc", slug: "price_abc" })],
      [{ stripePriceId: "price_gone", categoryId: 2, visible: 0, sortOrder: 0 }],
      CATEGORIES
    );

    expect(items).toHaveLength(1);
    expect(items[0].visible).toBe(true);
  });

  it("copes with nothing and with junk", () => {
    expect(applyItemSettings([], [], [])).toEqual([]);
    expect(applyItemSettings(undefined, undefined, undefined)).toEqual([]);
    expect(applyItemSettings([null], [], [])).toEqual([]);
  });
});

describe("the storefront's view of the products", () => {
  const items = [
    stripeItem({ stripePriceId: "p1", slug: "p1", displayName: "Knight" }),
    stripeItem({ stripePriceId: "p2", slug: "p2", displayName: "Lord" }),
    stripeItem({ stripePriceId: "p3", slug: "p3", displayName: "Secret" }),
    stripeItem({ stripePriceId: "p4", slug: "p4", displayName: "Unreleased" }),
  ];
  const settings = [
    { stripePriceId: "p1", categoryId: 1, visible: 1, sortOrder: 1 },
    { stripePriceId: "p2", categoryId: 2, visible: 1, sortOrder: 0 },
    { stripePriceId: "p3", categoryId: 1, visible: 0, sortOrder: 2 },
    { stripePriceId: "p4", categoryId: 3, visible: 1, sortOrder: 0 },
  ];

  it("shows only what the public may see, grouped and ordered", () => {
    const groups = groupByCategory(applyItemSettings(items, settings, CATEGORIES), {
      publicOnly: true,
    });

    expect(groups.map((g) => g.displayName)).toEqual(["Ranks", "Cosmetics"]);
    // "Secret" is hidden, "Unreleased" sits in a hidden category.
    expect(groups[0].packages.map((p) => p.displayName)).toEqual(["Knight"]);
    expect(groups[1].packages.map((p) => p.displayName)).toEqual(["Lord"]);
  });

  it("shows everything, hidden included, when the dashboard asks", () => {
    const groups = groupByCategory(applyItemSettings(items, settings, CATEGORIES));
    const all = groups.flatMap((g) => g.packages.map((p) => p.displayName));

    expect(all).toContain("Secret");
    expect(all).toContain("Unreleased");
    expect(all).toHaveLength(4);
  });

  it("puts everything in one unnamed group while no categories are assigned", () => {
    // The storefront renders this as the flat grid it has always been.
    const groups = groupByCategory(applyItemSettings(items, [], CATEGORIES), {
      publicOnly: true,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBeNull();
    expect(groups[0].packages).toHaveLength(4);
  });
});
