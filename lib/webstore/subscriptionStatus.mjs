/**
 * Pure rules for applying Stripe subscription events to the local
 * webstoreSubscriptions row. No DB import, so it is unit-testable.
 */

/** Map a Stripe subscription status string to our local ENUM. */
export function stripeStatusToLocal(stripeStatus) {
  const map = {
    active: "active",
    trialing: "active",
    past_due: "past_due",
    incomplete: "past_due",
    incomplete_expired: "expired",
    canceled: "cancelled",
    unpaid: "unpaid",
  };
  return map[stripeStatus] || "past_due";
}

/** Local statuses a subscription never leaves. */
export const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["cancelled", "expired"]);

/**
 * Decide whether a customer.subscription.updated event may be applied.
 *
 * Stripe does not guarantee delivery order, so:
 *  - an ended subscription (cancelled/expired) is never revived by an update;
 *  - an event older than the last one applied is dropped;
 *  - 'unpaid' is set locally when we revoke after repeated payment failures,
 *    and only invoice.payment_succeeded (which also re-grants) may lift it, so
 *    an update cannot quietly move it back to past_due/active.
 *
 * @returns {{apply: boolean, status?: string, reason?: string}}
 */
export function planSubscriptionUpdate({ currentStatus, lastStripeEventAt, eventCreated, incomingStripeStatus }) {
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(currentStatus)) {
    return { apply: false, reason: "terminal" };
  }
  const last = Number(lastStripeEventAt) || 0;
  const created = Number(eventCreated) || 0;
  if (last && created && created < last) {
    return { apply: false, reason: "stale" };
  }
  let status = stripeStatusToLocal(incomingStripeStatus);
  if (currentStatus === "unpaid" && (status === "active" || status === "past_due")) {
    status = "unpaid";
  }
  return { apply: true, status };
}
