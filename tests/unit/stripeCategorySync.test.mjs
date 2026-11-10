/**
 * tests/unit/stripeCategorySync.test.mjs
 *
 * The "Stripe seeds, dashboard overrides" rule for storefront categories.
 */

import { describe, expect, it } from "vitest";
import { planStripeCategorySync } from "../../lib/webstore/stripeCategorySync.mjs";

const keys = new Map([
  ["EdenEffects", 10],
  ["Ranks", 20],
]);

function item(stripePriceId, stripeCategory = null) {
  return { stripePriceId, stripeCategory };
}

describe("planStripeCategorySync", () => {
  it("seeds a brand-new product from its Stripe category", () => {
    const changes = planStripeCategorySync([item("price_1", "EdenEffects")], new Map(), keys);
    expect(changes).toEqual([{ stripePriceId: "price_1", categoryId: 10 }]);
  });

  it("never touches a product an admin categorised by hand", () => {
    const settings = new Map([["price_1", { categoryId: 20, categoryManual: true }]]);
    const changes = planStripeCategorySync([item("price_1", "EdenEffects")], settings, keys);
    expect(changes).toEqual([]);
  });

  it("respects an explicit manual 'no category' over a Stripe one", () => {
    const settings = new Map([["price_1", { categoryId: null, categoryManual: true }]]);
    const changes = planStripeCategorySync([item("price_1", "EdenEffects")], settings, keys);
    expect(changes).toEqual([]);
  });

  it("creates no settings row for an uncategorised product with no Stripe category", () => {
    const changes = planStripeCategorySync([item("price_1", null)], new Map(), keys);
    expect(changes).toEqual([]);
  });

  it("moves a Stripe-sourced product when its metadata category changes", () => {
    const settings = new Map([["price_1", { categoryId: 20, categoryManual: false }]]);
    const changes = planStripeCategorySync([item("price_1", "EdenEffects")], settings, keys);
    expect(changes).toEqual([{ stripePriceId: "price_1", categoryId: 10 }]);
  });

  it("clears a Stripe-sourced category when the metadata is removed", () => {
    const settings = new Map([["price_1", { categoryId: 10, categoryManual: false }]]);
    const changes = planStripeCategorySync([item("price_1", null)], settings, keys);
    expect(changes).toEqual([{ stripePriceId: "price_1", categoryId: null }]);
  });

  it("leaves a product alone when its Stripe handle did not resolve", () => {
    const changes = planStripeCategorySync([item("price_1", "Unknown")], new Map(), keys);
    expect(changes).toEqual([]);
  });

  it("emits nothing when the assignment is already correct", () => {
    const settings = new Map([["price_1", { categoryId: 10, categoryManual: false }]]);
    const changes = planStripeCategorySync([item("price_1", "EdenEffects")], settings, keys);
    expect(changes).toEqual([]);
  });

  it("trims whitespace in the Stripe category before matching", () => {
    const changes = planStripeCategorySync([item("price_1", "  EdenEffects ")], new Map(), keys);
    expect(changes).toEqual([{ stripePriceId: "price_1", categoryId: 10 }]);
  });

  it("skips items without a price id and tolerates junk input", () => {
    expect(planStripeCategorySync(null, new Map(), keys)).toEqual([]);
    expect(planStripeCategorySync([null, {}, item("", "Ranks")], new Map(), keys)).toEqual([]);
  });
});
