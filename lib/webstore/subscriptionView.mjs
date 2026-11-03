/**
 * lib/webstore/subscriptionView.mjs
 *
 * Shapes a webstoreSubscriptions row (from getUserSubscriptions) into what the
 * "My Subscriptions" table on /webstore/history renders.  No DB import, so it
 * is unit-testable.
 */

import { isAnonymousGift, publicGifterName } from "./giftPrivacy.mjs";

const STATUS = {
  active: { label: "Active", badge: "bg-success" },
  past_due: { label: "Payment overdue", badge: "bg-warning text-dark" },
  unpaid: { label: "Unpaid", badge: "bg-danger" },
  cancelled: { label: "Cancelled", badge: "bg-secondary" },
  expired: { label: "Expired", badge: "bg-secondary" },
};

function sameName(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function formatDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" });
}

function formatAmount(cents, currency) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format((cents || 0) / 100);
  } catch {
    return `${((cents || 0) / 100).toFixed(2)} ${(currency || "").toUpperCase()}`.trim();
  }
}

/**
 * @param {object} row       a row from getUserSubscriptions()
 * @param {number} viewerUserId  the logged-in user's userId
 */
export function describeSubscription(row, viewerUserId) {
  const isPurchaser = Number(row.purchaserUserId) === Number(viewerUserId);
  const forSelf = sameName(row.recipientMinecraftUsername, row.purchaserMinecraftUsername);
  const status = STATUS[row.status] || { label: String(row.status || "Unknown"), badge: "bg-secondary" };
  const cancelling = Boolean(Number(row.cancelAtPeriodEnd)) && row.status === "active";
  const periodEnd = formatDate(row.currentPeriodEnd);

  let renewal;
  if (!periodEnd) renewal = "—";
  else if (cancelling) renewal = `Ends ${periodEnd}`;
  else if (row.status === "active") renewal = `Renews ${periodEnd}`;
  else renewal = `Period ended ${periodEnd}`;

  // The purchaser always sees who they're paying for; only a recipient of an
  // anonymous gift has the gifter's name withheld.
  const anonymous = isAnonymousGift(row);
  const gifterName = isPurchaser ? row.purchaserMinecraftUsername : publicGifterName(row);

  return {
    subscriptionId: row.subscriptionId,
    itemName: row.itemName,
    username: row.recipientMinecraftUsername,
    relationship: isPurchaser ? (forSelf ? "self" : "gifted") : "received",
    purchaserUsername: gifterName,
    isAnonymous: anonymous,
    amount: `${formatAmount(row.amountCents, row.currency)} / month`,
    statusLabel: cancelling ? "Cancelling" : status.label,
    statusBadge: cancelling ? "bg-secondary" : status.badge,
    renewal,
    canManage: isPurchaser && Boolean(Number(row.hasBillingCustomer)),
  };
}
