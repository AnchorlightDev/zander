/**
 * tests/unit/catalogVisibility.test.mjs
 *
 * The rules deciding what the public /ranks page may show.
 *
 * Worth testing directly rather than through the controller: getting these
 * wrong puts an unfinished or deliberately pulled product in front of
 * customers, and the failure is silent -- the page renders perfectly, just
 * with something on it that should not be there.
 */

import { describe, expect, it } from "vitest";
import {
  groupByCategory,
  isCategoryVisible,
  isProductVisible,
  isPubliclyVisible,
  withEmptyCategories,
} from "../../lib/webstore/catalogVisibility.mjs";

/** A row shaped like what the catalog query returns. */
function row(overrides = {}) {
  return {
    id: 1,
    displayName: "Knight",
    visible: 1,
    categoryId: 10,
    categoryName: "Ranks",
    categoryVisible: 1,
    categorySortOrder: 0,
    sortOrder: 0,
    ...overrides,
  };
}

describe("reading the visibility flags", () => {
  it("accepts every shape the driver might hand back", () => {
    // mysql2 gives TINYINT(1) as 1/0, but a driver or a stub may give booleans.
    expect(isProductVisible({ visible: 1 })).toBe(true);
    expect(isProductVisible({ visible: true })).toBe(true);
    expect(isProductVisible({ visible: 0 })).toBe(false);
    expect(isProductVisible({ visible: false })).toBe(false);
    expect(isProductVisible({ visible: "0" })).toBe(false);
  });

  it("treats a missing flag as visible, not as hidden", () => {
    // The column is NOT NULL DEFAULT 1. A query that forgets to select it must
    // not blank the entire store.
    expect(isProductVisible({})).toBe(true);
    expect(isProductVisible({ visible: undefined })).toBe(true);
    expect(isProductVisible({ visible: null })).toBe(true);
    expect(isCategoryVisible({})).toBe(true);
  });

  it("needs both the product and its category to be visible", () => {
    expect(isPubliclyVisible(row())).toBe(true);
    expect(isPubliclyVisible(row({ visible: 0 }))).toBe(false);
    expect(isPubliclyVisible(row({ categoryVisible: 0 }))).toBe(false);
    expect(isPubliclyVisible(row({ visible: 0, categoryVisible: 0 }))).toBe(false);
  });
});

describe("groupByCategory", () => {
  it("groups rows under their category", () => {
    const groups = groupByCategory([
      row({ id: 1, displayName: "Knight", categoryId: 10, categoryName: "Ranks" }),
      row({ id: 2, displayName: "Lord", categoryId: 10, categoryName: "Ranks" }),
      row({ id: 3, displayName: "Hat", categoryId: 20, categoryName: "Cosmetics", categorySortOrder: 1 }),
    ]);

    expect(groups.map((g) => g.displayName)).toEqual(["Ranks", "Cosmetics"]);
    expect(groups[0].packages).toHaveLength(2);
    expect(groups[1].packages).toHaveLength(1);
  });

  it("orders categories by sort order, then products within them", () => {
    const groups = groupByCategory([
      row({ id: 1, displayName: "B", categoryId: 20, categoryName: "Second", categorySortOrder: 5, sortOrder: 2 }),
      row({ id: 2, displayName: "A", categoryId: 20, categoryName: "Second", categorySortOrder: 5, sortOrder: 1 }),
      row({ id: 3, displayName: "C", categoryId: 10, categoryName: "First", categorySortOrder: 1, sortOrder: 0 }),
    ]);

    expect(groups.map((g) => g.displayName)).toEqual(["First", "Second"]);
    expect(groups[1].packages.map((p) => p.displayName)).toEqual(["A", "B"]);
  });

  it("keeps hidden things when the dashboard asks for everything", () => {
    const groups = groupByCategory([
      row({ id: 1, visible: 0 }),
      row({ id: 2, visible: 1 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].packages).toHaveLength(2);
  });

  it("drops a hidden product from the public page", () => {
    const groups = groupByCategory(
      [row({ id: 1, displayName: "Draft", visible: 0 }), row({ id: 2, displayName: "Live", visible: 1 })],
      { publicOnly: true }
    );

    expect(groups[0].packages.map((p) => p.displayName)).toEqual(["Live"]);
  });

  it("drops every product in a hidden category, however each is set", () => {
    // This is the whole point of hiding a category: stage a section, publish it
    // in one switch, without touching each product.
    const groups = groupByCategory(
      [
        row({ id: 1, displayName: "Ready", visible: 1, categoryVisible: 0 }),
        row({ id: 2, displayName: "Also ready", visible: 1, categoryVisible: 0 }),
      ],
      { publicOnly: true }
    );

    expect(groups).toEqual([]);
  });

  it("removes a category left with nothing the public may see", () => {
    const groups = groupByCategory(
      [
        row({ id: 1, categoryId: 10, categoryName: "Ranks", visible: 1 }),
        row({ id: 2, categoryId: 20, categoryName: "Secret", categorySortOrder: 1, visible: 0 }),
      ],
      { publicOnly: true }
    );

    expect(groups.map((g) => g.displayName)).toEqual(["Ranks"]);
  });

  it("does not lose a row that has no category", () => {
    // The migration backfills these, but a hand-inserted row could still arrive
    // without one, and silently vanishing from the dashboard would hide the bug.
    const groups = groupByCategory([
      row({ id: 1, categoryId: null, categoryName: null }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].displayName).toBe("Uncategorised");
    expect(groups[0].id).toBeNull();
  });

  it("copes with nothing and with junk", () => {
    expect(groupByCategory([])).toEqual([]);
    expect(groupByCategory(undefined)).toEqual([]);
    expect(groupByCategory([null, undefined])).toEqual([]);
  });

  it("keeps the shape views/ranks.ejs and the SEO builder consume", () => {
    const groups = groupByCategory([row()], { publicOnly: true });

    expect(groups[0]).toHaveProperty("displayName");
    expect(Array.isArray(groups[0].packages)).toBe(true);
  });
});

describe("withEmptyCategories", () => {
  it("shows a category holding no products, so the first one can be added to it", () => {
    const groups = groupByCategory([row({ categoryId: 10, categoryName: "Ranks" })]);
    const merged = withEmptyCategories(groups, [
      { id: 10, name: "Ranks", sortOrder: 0, visible: 1 },
      { id: 20, name: "Brand new", sortOrder: 1, visible: 1 },
    ]);

    expect(merged.map((g) => g.displayName)).toEqual(["Ranks", "Brand new"]);
    expect(merged[1].packages).toEqual([]);
  });

  it("does not duplicate a category that already has products", () => {
    const groups = groupByCategory([row({ categoryId: 10, categoryName: "Ranks" })]);
    const merged = withEmptyCategories(groups, [{ id: 10, name: "Ranks", sortOrder: 0, visible: 1 }]);

    expect(merged).toHaveLength(1);
    expect(merged[0].packages).toHaveLength(1);
  });

  it("carries the hidden state of an empty category through", () => {
    const merged = withEmptyCategories([], [{ id: 20, name: "Staged", sortOrder: 0, visible: 0 }]);

    expect(merged[0].visible).toBe(false);
  });

  it("copes with nothing", () => {
    expect(withEmptyCategories([], [])).toEqual([]);
    expect(withEmptyCategories([], undefined)).toEqual([]);
  });
});
