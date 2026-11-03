/**
 * tests/unit/webstoreGiftPrivacy.test.mjs
 *
 * Anonymous gifting. The property that matters: a recipient never learns who
 * sent an anonymous gift, while the purchaser always sees their own gift.
 */

import { describe, expect, it } from "vitest";
import { ANONYMOUS_GIFTER, isAnonymousGift, publicGifterName } from "../../lib/webstore/giftPrivacy.mjs";
import { describeSubscription } from "../../lib/webstore/subscriptionView.mjs";

describe("publicGifterName", () => {
  it("returns the real name for a normal gift", () => {
    expect(publicGifterName({ purchaserMinecraftUsername: "Steve", isAnonymous: 0 })).toBe("Steve");
  });

  it("hides the name for an anonymous gift", () => {
    expect(publicGifterName({ purchaserMinecraftUsername: "Steve", isAnonymous: 1 })).toBe(ANONYMOUS_GIFTER);
  });

  it("treats a missing flag (pre-migration rows) as not anonymous", () => {
    expect(isAnonymousGift({ purchaserMinecraftUsername: "Steve" })).toBe(false);
    expect(publicGifterName({ purchaserMinecraftUsername: "Steve" })).toBe("Steve");
  });
});

describe("describeSubscription with anonymous gifts", () => {
  const sub = {
    subscriptionId: 3,
    status: "active",
    recipientMinecraftUsername: "Alex",
    purchaserMinecraftUsername: "Steve",
    purchaserUserId: 1,
    isAnonymous: 1,
    currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    cancelAtPeriodEnd: 0,
    hasBillingCustomer: 1,
    itemName: "Knight Rank",
    amountCents: 500,
    currency: "aud",
  };

  it("hides the gifter from the recipient", () => {
    const s = describeSubscription(sub, 2);
    expect(s.relationship).toBe("received");
    expect(s.purchaserUsername).toBe(ANONYMOUS_GIFTER);
    expect(JSON.stringify(s)).not.toContain("Steve");
    expect(s.canManage).toBe(false);
  });

  it("still shows the purchaser their own anonymous gift", () => {
    const s = describeSubscription(sub, 1);
    expect(s.relationship).toBe("gifted");
    expect(s.isAnonymous).toBe(true);
    expect(s.username).toBe("Alex");
    expect(s.canManage).toBe(true);
  });
});
