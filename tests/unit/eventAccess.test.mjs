import { describe, it, expect } from "vitest";
import {
  normaliseRankSlugs,
  viewerRankSlugs,
  eventRankSlugs,
  resolveEventAccess,
  redactLockedEvent,
  isSupporterEvent,
  buildLockCopy,
  describeRequiredRanks,
} from "../../lib/eventAccess.js";

const rankMeta = new Map([
  ["supporter", { rankSlug: "supporter", displayName: "Supporter", isDonator: true }],
  ["patron", { rankSlug: "patron", displayName: "Patron", isDonator: true }],
  ["admin", { rankSlug: "admin", displayName: "Admin", isStaff: true }],
]);

/** A published, rank-locked event with a public teaser. */
function lockedEvent(overrides = {}) {
  return {
    eventId: 1,
    title: "Winter Build Comp",
    description: "<p>Secret details</p>",
    serverIp: "play.example.net",
    hosts: [{ displayName: "Ben" }],
    visibility: "rank",
    teaserPublic: true,
    rankAccess: [{ rankSlug: "supporter" }],
    ...overrides,
  };
}

describe("normaliseRankSlugs", () => {
  it("lower-cases, trims and de-duplicates", () => {
    expect(normaliseRankSlugs([" Supporter ", "SUPPORTER", "patron"])).toEqual([
      "supporter",
      "patron",
    ]);
  });

  it("accepts the {rankSlug} row shape used by the session and the DB", () => {
    expect(normaliseRankSlugs([{ rankSlug: "Supporter" }, { rankSlug: "admin" }])).toEqual([
      "supporter",
      "admin",
    ]);
  });

  it("accepts a comma-separated string", () => {
    expect(normaliseRankSlugs("supporter, patron")).toEqual(["supporter", "patron"]);
  });

  it("returns an empty array for null/undefined/garbage", () => {
    expect(normaliseRankSlugs(null)).toEqual([]);
    expect(normaliseRankSlugs(undefined)).toEqual([]);
    expect(normaliseRankSlugs([null, "", "   "])).toEqual([]);
  });
});

describe("viewerRankSlugs", () => {
  it("reads the session shape built at login", () => {
    const req = { session: { user: { ranks: [{ rankSlug: "Supporter" }] } } };
    expect(viewerRankSlugs(req)).toEqual(["supporter"]);
  });

  it("returns an empty array for a logged-out visitor", () => {
    expect(viewerRankSlugs({ session: {} })).toEqual([]);
    expect(viewerRankSlugs(undefined)).toEqual([]);
  });
});

describe("eventRankSlugs", () => {
  it("reads the rankAccess relation", () => {
    expect(eventRankSlugs(lockedEvent())).toEqual(["supporter"]);
  });
});

describe("resolveEventAccess", () => {
  it("leaves public events alone", () => {
    const access = resolveEventAccess({ visibility: "public" }, []);
    expect(access).toEqual({ visible: true, locked: false, requiredRanks: [] });
  });

  it("treats a missing visibility as public", () => {
    expect(resolveEventAccess({}, []).visible).toBe(true);
    expect(resolveEventAccess({}, []).locked).toBe(false);
  });

  it("hides private events from the public entirely", () => {
    const access = resolveEventAccess({ visibility: "private" }, ["supporter"]);
    expect(access.visible).toBe(false);
    expect(access.locked).toBe(false);
  });

  it("shows private events to staff", () => {
    expect(resolveEventAccess({ visibility: "private" }, [], { isStaff: true }).visible).toBe(true);
  });

  it("unlocks a rank-locked event for a holder of the rank", () => {
    const access = resolveEventAccess(lockedEvent(), ["supporter"]);
    expect(access.visible).toBe(true);
    expect(access.locked).toBe(false);
  });

  it("unlocks when the viewer holds any one of several allowed ranks", () => {
    const event = lockedEvent({ rankAccess: [{ rankSlug: "supporter" }, { rankSlug: "patron" }] });
    expect(resolveEventAccess(event, ["patron"]).locked).toBe(false);
  });

  it("matches ranks case-insensitively", () => {
    expect(resolveEventAccess(lockedEvent(), ["SUPPORTER"]).locked).toBe(false);
  });

  it("locks, but still shows, a teaser event for a non-holder", () => {
    const access = resolveEventAccess(lockedEvent(), ["default"]);
    expect(access.visible).toBe(true);
    expect(access.locked).toBe(true);
    expect(access.requiredRanks).toEqual(["supporter"]);
  });

  it("locks a teaser event for a logged-out visitor", () => {
    const access = resolveEventAccess(lockedEvent(), []);
    expect(access.visible).toBe(true);
    expect(access.locked).toBe(true);
  });

  it("hides a rank-locked event entirely when the teaser is switched off", () => {
    const access = resolveEventAccess(lockedEvent({ teaserPublic: false }), ["default"]);
    expect(access.visible).toBe(false);
    expect(access.locked).toBe(true);
  });

  it("still unlocks a teaser-off event for a rank holder", () => {
    const access = resolveEventAccess(lockedEvent({ teaserPublic: false }), ["supporter"]);
    expect(access.visible).toBe(true);
    expect(access.locked).toBe(false);
  });

  it("falls back to public when a rank-locked event has no ranks selected", () => {
    // Otherwise the event would be invisible to everyone, including the people
    // it was created for.
    const access = resolveEventAccess(lockedEvent({ rankAccess: [] }), []);
    expect(access.visible).toBe(true);
    expect(access.locked).toBe(false);
  });

  it("lets staff through a rank lock they do not hold", () => {
    const access = resolveEventAccess(lockedEvent(), ["default"], { isStaff: true });
    expect(access.locked).toBe(false);
    expect(access.visible).toBe(true);
  });
});

describe("redactLockedEvent", () => {
  it("strips the withheld fields and keeps the teaser ones", () => {
    const teaser = redactLockedEvent(lockedEvent({ bannerUrl: "b.png", startAt: "2026-12-12" }));

    expect(teaser.description).toBeNull();
    expect(teaser.serverIp).toBeNull();
    expect(teaser.locationLabel).toBeNull();
    expect(teaser.externalLinks).toBeNull();
    expect(teaser.hosts).toEqual([]);

    expect(teaser.title).toBe("Winter Build Comp");
    expect(teaser.bannerUrl).toBe("b.png");
    expect(teaser.startAt).toBe("2026-12-12");
    expect(teaser.isLocked).toBe(true);
  });

  it("does not mutate the event it was given", () => {
    const event = lockedEvent();
    redactLockedEvent(event);
    expect(event.description).toBe("<p>Secret details</p>");
    expect(event.hosts).toHaveLength(1);
  });

  it("shows the organiser's teaser copy in place of the gated description", () => {
    const teaser = redactLockedEvent(
      lockedEvent({ teaserDescription: "<p>One chunk. Then the world.</p>" })
    );
    expect(teaser.description).toBe("<p>One chunk. Then the world.</p>");
    expect(teaser.description).not.toContain("Secret details");
  });

  it("still withholds everything else when a teaser is set", () => {
    const teaser = redactLockedEvent(lockedEvent({ teaserDescription: "<p>Blurb</p>" }));
    expect(teaser.serverIp).toBeNull();
    expect(teaser.hosts).toEqual([]);
  });

  it("falls back to generated copy when no teaser was written", () => {
    expect(redactLockedEvent(lockedEvent()).description).toBeNull();
  });
});

describe("isSupporterEvent", () => {
  it("is true when any required rank is purchasable", () => {
    expect(isSupporterEvent(["supporter"], ["supporter", "patron"])).toBe(true);
    expect(isSupporterEvent(["admin", "patron"], ["supporter", "patron"])).toBe(true);
  });

  it("is false for a staff-only or veteran-only event", () => {
    expect(isSupporterEvent(["admin"], ["supporter", "patron"])).toBe(false);
  });

  it("is false when no donator ranks are configured", () => {
    expect(isSupporterEvent(["supporter"], [])).toBe(false);
  });
});

describe("buildLockCopy", () => {
  it("sends a supporter event to the webstore", () => {
    const copy = buildLockCopy(["supporter"], rankMeta, true, true);
    expect(copy.ctaUrl).toBe("/webstore");
    expect(copy.ctaLabel).toBe("Support the Server");
    expect(copy.heading).toBe("Supporter event");
    expect(copy.body).toContain("Supporter");
  });

  it("offers no purchase route for a non-purchasable rank", () => {
    const copy = buildLockCopy(["admin"], rankMeta, false, true);
    expect(copy.ctaUrl).toBeNull();
    expect(copy.ctaLabel).toBeNull();
    expect(copy.heading).toBe("Restricted event");
  });

  it("asks a logged-out visitor to sign in first, since they may already qualify", () => {
    const copy = buildLockCopy(["supporter"], rankMeta, true, false);
    expect(copy.ctaUrl).toBe("/login");
    expect(copy.ctaLabel).toBe("Sign In");
  });

  it("uses LuckPerms display names, not slugs", () => {
    expect(buildLockCopy(["supporter"], rankMeta, true, true).rankList).toBe("Supporter");
  });

  it("falls back to the slug when the rank has no metadata", () => {
    expect(buildLockCopy(["mystery"], rankMeta, false, true).rankList).toBe("mystery");
  });

  it("reads naturally with several purchasable ranks", () => {
    const copy = buildLockCopy(["supporter", "patron"], rankMeta, true, true);
    expect(copy.rankList).toBe("Patron or Supporter");
  });
});

describe("describeRequiredRanks", () => {
  // Weighted so "cheapest first" is unambiguous rather than alphabetical.
  const tiers = new Map([
    ["iron",     { rankSlug: "iron",     displayName: "Iron",     isDonator: true, priority: 10 }],
    ["gold",     { rankSlug: "gold",     displayName: "Gold",     isDonator: true, priority: 20 }],
    ["diamond",  { rankSlug: "diamond",  displayName: "Diamond",  isDonator: true, priority: 30 }],
    ["emerald",  { rankSlug: "emerald",  displayName: "Emerald",  isDonator: true, priority: 40 }],
    ["admin",    { rankSlug: "admin",    displayName: "Administrator", isStaff: true, priority: 900 }],
    ["mod",      { rankSlug: "mod",      displayName: "Moderator",     isStaff: true, priority: 800 }],
  ]);

  it("drops staff ranks from a supporter prompt, since no reader can buy one", () => {
    const out = describeRequiredRanks(["admin", "mod", "iron"], tiers, true);
    expect(out).toBe("Iron");
    expect(out).not.toContain("Administrator");
  });

  it("names the cheapest tier first", () => {
    expect(describeRequiredRanks(["diamond", "iron", "gold"], tiers, true)).toBe(
      "Iron, Gold or Diamond"
    );
  });

  it("collapses a long list rather than enumerating every tier", () => {
    // The real case: every donator tier plus every staff rank was printed in
    // full, which read as noise and answered nothing.
    const out = describeRequiredRanks(
      ["emerald", "diamond", "gold", "iron", "admin", "mod"],
      tiers,
      true
    );
    expect(out).toBe("Iron, Gold, Diamond and above");
  });

  it("keeps staff names on a non-supporter event, where they are the answer", () => {
    expect(describeRequiredRanks(["admin", "mod"], tiers, false)).toBe(
      "Moderator or Administrator"
    );
  });

  it("falls back to every rank when none are purchasable", () => {
    // Guards against an empty prompt if the donator flags are missing.
    expect(describeRequiredRanks(["admin"], tiers, true)).toBe("Administrator");
  });

  it("uses the slug when a rank has no metadata", () => {
    expect(describeRequiredRanks(["mystery"], tiers, true)).toBe("mystery");
  });

  it("describes an empty list without naming anything", () => {
    expect(describeRequiredRanks([], tiers, true)).toBe("a special rank");
  });
});
