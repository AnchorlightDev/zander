import { describe, it, expect } from "vitest";
import { dollarsToCents, pickSupportTotal } from "../../lib/finance/money.mjs";
import { planSubscriptionUpdate, stripeStatusToLocal } from "../../lib/webstore/subscriptionStatus.mjs";
import { planDeferredRoleRuns } from "../../lib/webstore/deferredRoles.mjs";

describe("dollarsToCents (finance account forms post dollars)", () => {
  it("treats a whole number as dollars, not cents", () => {
    expect(dollarsToCents("1500")).toBe(150000);
    expect(dollarsToCents(1500)).toBe(150000);
  });

  it("handles decimals, separators and symbols", () => {
    expect(dollarsToCents("1500.00")).toBe(150000);
    expect(dollarsToCents("19.99")).toBe(1999);
    expect(dollarsToCents("$1,234.5")).toBe(123450);
    expect(dollarsToCents("-12.30")).toBe(-1230);
  });

  it("returns 0 for empty or junk input", () => {
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents(undefined)).toBe(0);
    expect(dollarsToCents("abc")).toBe(0);
  });
});

describe("pickSupportTotal", () => {
  const rows = [
    { currency: "AUD", totalCents: 5000 },
    { currency: "usd", totalCents: 1200 },
  ];

  it("counts only the preferred currency in the headline and lists the rest", () => {
    expect(pickSupportTotal(rows, "aud")).toEqual({
      currency: "AUD",
      cents: 5000,
      otherCurrencies: [{ currency: "USD", cents: 1200 }],
    });
  });

  it("never adds two currencies together", () => {
    expect(pickSupportTotal(rows, "USD").cents).toBe(1200);
  });

  it("falls back to the currency that took the most", () => {
    expect(pickSupportTotal(rows, null).currency).toBe("AUD");
  });

  it("is zero when nothing was taken in the preferred currency", () => {
    expect(pickSupportTotal(rows, "GBP").cents).toBe(0);
    expect(pickSupportTotal([], null)).toEqual({ currency: null, cents: 0, otherCurrencies: [] });
  });
});

describe("planSubscriptionUpdate (out-of-order customer.subscription.updated)", () => {
  it("never revives a cancelled or expired subscription", () => {
    expect(planSubscriptionUpdate({ currentStatus: "cancelled", incomingStripeStatus: "active" }).apply).toBe(false);
    expect(planSubscriptionUpdate({ currentStatus: "expired", incomingStripeStatus: "past_due" }).apply).toBe(false);
  });

  it("drops an event older than the last one applied", () => {
    const plan = planSubscriptionUpdate({
      currentStatus: "active",
      lastStripeEventAt: 2000,
      eventCreated: 1000,
      incomingStripeStatus: "past_due",
    });
    expect(plan).toEqual({ apply: false, reason: "stale" });
  });

  it("applies a newer event", () => {
    expect(
      planSubscriptionUpdate({ currentStatus: "past_due", lastStripeEventAt: 1000, eventCreated: 2000, incomingStripeStatus: "active" })
    ).toEqual({ apply: true, status: "active" });
  });

  it("keeps a locally revoked (unpaid) subscription unpaid", () => {
    expect(planSubscriptionUpdate({ currentStatus: "unpaid", incomingStripeStatus: "past_due" }).status).toBe("unpaid");
    expect(planSubscriptionUpdate({ currentStatus: "unpaid", incomingStripeStatus: "active" }).status).toBe("unpaid");
    expect(planSubscriptionUpdate({ currentStatus: "unpaid", incomingStripeStatus: "canceled" }).status).toBe("cancelled");
  });

  it("maps Stripe statuses", () => {
    expect(stripeStatusToLocal("trialing")).toBe("active");
    expect(stripeStatusToLocal("canceled")).toBe("cancelled");
    expect(stripeStatusToLocal("something_new")).toBe("past_due");
  });
});

describe("planDeferredRoleRuns", () => {
  const grant = { commandRunId: 10, purchaseId: 1, action: "grant", commandTemplate: "role1", purchaseType: "subscription", subscriptionStatus: "cancelled" };
  const revoke = { commandRunId: 11, purchaseId: 1, action: "revoke", commandTemplate: "role1", purchaseType: "subscription", subscriptionStatus: "cancelled" };

  it("ends with the role removed whatever order the rows arrive in", () => {
    const plan = planDeferredRoleRuns([revoke, grant]);
    expect(plan.map((p) => [p.run.commandRunId, p.decision])).toEqual([
      [10, "superseded"],
      [11, "remove"],
    ]);
  });

  it("drops a grant for a subscription that has ended", () => {
    expect(planDeferredRoleRuns([grant])[0].decision).toBe("inactive");
  });

  it("drops a grant for a refunded purchase", () => {
    const run = { commandRunId: 1, purchaseId: 2, action: "grant", commandTemplate: "r", purchaseType: "one_time", purchaseStatus: "refunded" };
    expect(planDeferredRoleRuns([run])[0].decision).toBe("inactive");
  });

  it("applies a grant that is still owed", () => {
    const run = { commandRunId: 1, purchaseId: 2, action: "grant", commandTemplate: "r", purchaseType: "subscription", subscriptionStatus: "active" };
    const oneTime = { commandRunId: 2, purchaseId: 3, action: "grant", commandTemplate: "r", purchaseType: "one_time", purchaseStatus: "fulfilled" };
    expect(planDeferredRoleRuns([run, oneTime]).map((p) => p.decision)).toEqual(["add", "add"]);
  });

  it("keeps different roles on the same purchase independent", () => {
    const a = { commandRunId: 1, purchaseId: 5, action: "grant", commandTemplate: "a", purchaseType: "one_time" };
    const b = { commandRunId: 2, purchaseId: 5, action: "grant", commandTemplate: "b", purchaseType: "one_time" };
    expect(planDeferredRoleRuns([a, b]).map((p) => p.decision)).toEqual(["add", "add"]);
  });
});
