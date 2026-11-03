/**
 * tests/unit/webstoreSubscriptionView.test.mjs
 *
 * Shaping webstoreSubscriptions rows for the "My Subscriptions" table on
 * /webstore/history. The property that matters most is canManage: only the
 * paying user may get a billing-portal button, never a gift recipient.
 */

import { describe, expect, it } from "vitest";
import { describeSubscription } from "../../lib/webstore/subscriptionView.mjs";

function row(overrides = {}) {
  return {
    subscriptionId: 7,
    status: "active",
    recipientMinecraftUsername: "Steve",
    purchaserMinecraftUsername: "Steve",
    purchaserUserId: 1,
    currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    cancelAtPeriodEnd: 0,
    hasBillingCustomer: 1,
    itemName: "Knight Rank",
    amountCents: 500,
    currency: "aud",
    ...overrides,
  };
}

describe("describeSubscription", () => {
  it("treats a self-purchase as manageable and renewing", () => {
    const s = describeSubscription(row(), 1);
    expect(s.relationship).toBe("self");
    expect(s.username).toBe("Steve");
    expect(s.canManage).toBe(true);
    expect(s.statusLabel).toBe("Active");
    expect(s.renewal).toMatch(/^Renews /);
    expect(s.amount).toContain("/ month");
  });

  it("shows the recipient username for a gift the viewer pays for", () => {
    const s = describeSubscription(row({ recipientMinecraftUsername: "Alex" }), 1);
    expect(s.relationship).toBe("gifted");
    expect(s.username).toBe("Alex");
    expect(s.canManage).toBe(true);
  });

  it("never lets a gift recipient manage the purchaser's billing", () => {
    const s = describeSubscription(
      row({ recipientMinecraftUsername: "Alex", purchaserUserId: 1 }),
      2
    );
    expect(s.relationship).toBe("received");
    expect(s.purchaserUsername).toBe("Steve");
    expect(s.canManage).toBe(false);
  });

  it("matches usernames case-insensitively when deciding self vs gift", () => {
    const s = describeSubscription(row({ recipientMinecraftUsername: "steve" }), 1);
    expect(s.relationship).toBe("self");
  });

  it("cannot be managed without a Stripe customer on record", () => {
    expect(describeSubscription(row({ hasBillingCustomer: 0 }), 1).canManage).toBe(false);
  });

  it("labels a subscription set to cancel at period end", () => {
    const s = describeSubscription(row({ cancelAtPeriodEnd: 1 }), 1);
    expect(s.statusLabel).toBe("Cancelling");
    expect(s.renewal).toMatch(/^Ends /);
  });

  it("flags overdue payments", () => {
    const s = describeSubscription(row({ status: "past_due" }), 1);
    expect(s.statusLabel).toBe("Payment overdue");
    expect(s.renewal).toMatch(/^Period ended /);
  });

  it("copes with a missing period end", () => {
    expect(describeSubscription(row({ currentPeriodEnd: null }), 1).renewal).toBe("—");
  });
});
