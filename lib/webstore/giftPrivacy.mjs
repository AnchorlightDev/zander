/**
 * lib/webstore/giftPrivacy.mjs
 *
 * Anonymous gifting: one place that decides what name a recipient (or the
 * public) sees for whoever paid.  Staff views read purchaserMinecraftUsername
 * directly and are unaffected.  No DB import, so it is unit-testable.
 */

export const ANONYMOUS_GIFTER = "Anonymous";

/** True when a purchase or subscription row is an anonymous gift. */
export function isAnonymousGift(row) {
  return Boolean(row) && Number(row.isAnonymous) === 1;
}

/**
 * The purchaser name safe to show outside staff tooling: the real username,
 * or "Anonymous" for an anonymous gift.
 */
export function publicGifterName(row) {
  if (!row) return "";
  return isAnonymousGift(row) ? ANONYMOUS_GIFTER : row.purchaserMinecraftUsername;
}
