import { describe, it, expect, vi } from "vitest";

// mergeRankMembers and classifyInviteeEligibility are pure, but importing the
// service pulls in databaseController, which opens a mysql2 pool and a
// PrismaClient at import time (same reason as tests/unit/apiClientAuth.test.mjs).
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  prisma: {},
  luckpermsDb: { query: vi.fn() },
}));

const {
  mergeRankMembers,
  classifyInviteeEligibility,
  INVITEE_BLOCKED_REASON,
  UNRESOLVED_REASON,
} = await import("../../services/meetingRosterService.js");

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";
const UUID_C = "33333333-3333-3333-3333-333333333333";

/** A fully registered `users` row — the baseline "can respond" case. */
function registeredUser(overrides = {}) {
  return {
    userId: 1,
    uuid: UUID_A,
    username: "Player",
    email: "player@example.com",
    password_hash: "hash",
    account_registered: new Date(),
    is_placeholder: 0,
    account_disabled: 0,
    ...overrides,
  };
}

describe("classifyInviteeEligibility", () => {
  it("lets a fully registered account respond", () => {
    expect(classifyInviteeEligibility(registeredUser())).toEqual({
      canRespond: true,
      blockedReason: null,
    });
  });

  it("blocks a placeholder profile", () => {
    const result = classifyInviteeEligibility(registeredUser({ is_placeholder: 1 }));
    expect(result.canRespond).toBe(false);
    expect(result.blockedReason).toBe(INVITEE_BLOCKED_REASON.PLACEHOLDER);
  });

  it("blocks a disabled account", () => {
    const result = classifyInviteeEligibility(registeredUser({ account_disabled: 1 }));
    expect(result.canRespond).toBe(false);
    expect(result.blockedReason).toBe(INVITEE_BLOCKED_REASON.ACCOUNT_DISABLED);
  });

  it("blocks a Minecraft-only profile with no website credentials", () => {
    const result = classifyInviteeEligibility(
      registeredUser({ email: null, password_hash: null, account_registered: null })
    );
    expect(result.canRespond).toBe(false);
    expect(result.blockedReason).toBe(INVITEE_BLOCKED_REASON.NO_WEBSITE_LOGIN);
  });

  it("blocks a Discord-only forcelink that never set a password", () => {
    const result = classifyInviteeEligibility(
      registeredUser({
        email: null,
        password_hash: null,
        account_registered: null,
        discordId: "123456789",
      })
    );
    expect(result.canRespond).toBe(false);
    expect(result.blockedReason).toBe(INVITEE_BLOCKED_REASON.NO_WEBSITE_LOGIN);
  });

  it("blocks a half-finished registration that has a password but never completed", () => {
    // meetingPollService.addManualInvitee once judged this by password_hash
    // alone and let them respond, while rank expansion blocked the same person.
    // Both paths now go through this function, so they agree.
    const result = classifyInviteeEligibility(
      registeredUser({ account_registered: null })
    );
    expect(result.canRespond).toBe(false);
    expect(result.blockedReason).toBe(INVITEE_BLOCKED_REASON.NO_WEBSITE_LOGIN);
  });

  it("treats mysql2's 0/1 tinyints and real booleans alike", () => {
    expect(classifyInviteeEligibility(registeredUser({ is_placeholder: true })).canRespond).toBe(false);
    expect(classifyInviteeEligibility(registeredUser({ is_placeholder: 1 })).canRespond).toBe(false);
    expect(classifyInviteeEligibility(registeredUser({ is_placeholder: false })).canRespond).toBe(true);
    expect(classifyInviteeEligibility(registeredUser({ is_placeholder: 0 })).canRespond).toBe(true);
  });
});

describe("mergeRankMembers", () => {
  it("turns a rank member with a website account into an invitee", () => {
    const { invitees, unresolved } = mergeRankMembers(
      ["moderator"],
      [{ uuid: UUID_A, rankSlug: "moderator" }],
      [registeredUser({ userId: 7, username: "Mod" })]
    );

    expect(unresolved).toEqual([]);
    expect(invitees).toEqual([
      {
        userId: 7,
        uuid: UUID_A,
        username: "Mod",
        source: "role",
        viaRankSlug: "moderator",
        canRespond: true,
        blockedReason: null,
      },
    ]);
  });

  it("keeps a user with no usable website login on the roster, flagged", () => {
    const { invitees } = mergeRankMembers(
      ["moderator"],
      [{ uuid: UUID_A, rankSlug: "moderator" }],
      [registeredUser({ userId: 7, username: "Placeheld", is_placeholder: 1 })]
    );

    // Flagged rather than dropped — the organiser needs to see the gap.
    expect(invitees).toHaveLength(1);
    expect(invitees[0].canRespond).toBe(false);
    expect(invitees[0].blockedReason).toBe(INVITEE_BLOCKED_REASON.PLACEHOLDER);
  });

  it("reports a rank member with no website account as unresolved", () => {
    const { invitees, unresolved } = mergeRankMembers(
      ["moderator"],
      [{ uuid: UUID_B, rankSlug: "moderator" }],
      [],
      new Map([[UUID_B, "NeverVisited"]])
    );

    expect(invitees).toEqual([]);
    expect(unresolved).toEqual([
      {
        uuid: UUID_B,
        username: "NeverVisited",
        viaRankSlug: "moderator",
        reason: UNRESOLVED_REASON.NO_WEB_ACCOUNT,
      },
    ]);
  });

  it("falls back to a null username when LuckPerms has no name either", () => {
    const { unresolved } = mergeRankMembers(
      ["moderator"],
      [{ uuid: UUID_B, rankSlug: "moderator" }],
      []
    );

    expect(unresolved[0].username).toBeNull();
    expect(unresolved[0].uuid).toBe(UUID_B);
  });

  it("invites a user in two selected ranks only once", () => {
    const { invitees } = mergeRankMembers(
      ["admin", "moderator"],
      [
        { uuid: UUID_A, rankSlug: "moderator" },
        { uuid: UUID_A, rankSlug: "admin" },
      ],
      [registeredUser({ userId: 7, username: "Both" })]
    );

    expect(invitees).toHaveLength(1);
  });

  it("attributes a multi-rank member to the first rank in the requested order", () => {
    // Row order from LuckPerms deliberately puts 'moderator' first, to prove
    // attribution follows the requested order rather than the result set.
    const { invitees } = mergeRankMembers(
      ["admin", "moderator"],
      [
        { uuid: UUID_A, rankSlug: "moderator" },
        { uuid: UUID_A, rankSlug: "admin" },
      ],
      [registeredUser({ userId: 7, username: "Both" })]
    );

    expect(invitees[0].viaRankSlug).toBe("admin");
  });

  it("matches uuids case-insensitively across the two databases", () => {
    const { invitees, unresolved } = mergeRankMembers(
      ["moderator"],
      [{ uuid: UUID_A.toUpperCase(), rankSlug: "moderator" }],
      [registeredUser({ userId: 7, uuid: UUID_A.toUpperCase(), username: "Shouty" })]
    );

    expect(unresolved).toEqual([]);
    expect(invitees).toHaveLength(1);
    expect(invitees[0].uuid).toBe(UUID_A);
  });

  it("merges several ranks into one roster, sorted by username", () => {
    const { invitees } = mergeRankMembers(
      ["admin", "moderator"],
      [
        { uuid: UUID_A, rankSlug: "admin" },
        { uuid: UUID_B, rankSlug: "moderator" },
        { uuid: UUID_C, rankSlug: "moderator" },
      ],
      [
        registeredUser({ userId: 1, uuid: UUID_A, username: "Zoe" }),
        registeredUser({ userId: 2, uuid: UUID_B, username: "Alice" }),
        registeredUser({ userId: 3, uuid: UUID_C, username: "Mia" }),
      ]
    );

    expect(invitees.map((i) => i.username)).toEqual(["Alice", "Mia", "Zoe"]);
  });

  it("splits a mixed rank into invitees and unresolved", () => {
    const { invitees, unresolved } = mergeRankMembers(
      ["moderator"],
      [
        { uuid: UUID_A, rankSlug: "moderator" },
        { uuid: UUID_B, rankSlug: "moderator" },
      ],
      [registeredUser({ userId: 1, uuid: UUID_A, username: "HasAccount" })],
      new Map([[UUID_B, "NoAccount"]])
    );

    expect(invitees.map((i) => i.username)).toEqual(["HasAccount"]);
    expect(unresolved.map((u) => u.username)).toEqual(["NoAccount"]);
  });

  it("returns empty lists when the ranks have no members", () => {
    expect(mergeRankMembers(["ghost"], [], [])).toEqual({ invitees: [], unresolved: [] });
  });

  it("skips a membership row with no uuid rather than throwing", () => {
    const { invitees, unresolved } = mergeRankMembers(
      ["moderator"],
      [{ uuid: null, rankSlug: "moderator" }],
      []
    );

    expect(invitees).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
