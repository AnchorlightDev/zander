import { describe, expect, it } from "vitest";
import {
  deadlineFrom,
  decideOutcome,
  isOverdue,
  majorityOf,
  normaliseUrlForMatch,
  parseCategory,
  parseResource,
  tallyVotes,
} from "../../lib/resources.mjs";
import { findGrantingGroups, findPermissionHolders, grantingNodes } from "../../lib/permissions/permissionHolders.mjs";

describe("majority", () => {
  it("needs more than half", () => {
    expect(majorityOf(1)).toBe(1);
    expect(majorityOf(4)).toBe(3);
    expect(majorityOf(5)).toBe(3);
  });

  it("counts only current reviewers", () => {
    const tally = tallyVotes(
      [
        { userId: 1, vote: "approve" },
        { userId: 2, vote: "approve" },
        { userId: 9, vote: "approve" }, // lost the permission
        { userId: 3, vote: "reject" },
      ],
      new Set([1, 2, 3, 4, 5])
    );
    expect(tally).toEqual({ approve: 2, reject: 1, eligible: 5, needed: 3 });
    expect(decideOutcome(tally)).toBeNull();
  });

  it("decides once a majority agree either way", () => {
    expect(decideOutcome({ approve: 3, reject: 0, eligible: 5 })).toBe("approved");
    expect(decideOutcome({ approve: 0, reject: 3, eligible: 5 })).toBe("rejected");
    expect(decideOutcome({ approve: 2, reject: 2, eligible: 4 })).toBeNull();
  });

  it("never passes with nobody to vote", () => {
    expect(decideOutcome({ approve: 0, reject: 0, eligible: 0 })).toBeNull();
  });
});

describe("deadlines", () => {
  it("adds the vote window", () => {
    expect(deadlineFrom("2026-01-01T00:00:00Z", 7).toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(deadlineFrom("2026-01-01T00:00:00Z", "bad").toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("is overdue only while pending and past the deadline", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(isOverdue({ status: "pending", deadlineAt: "2026-01-08T00:00:00Z" }, now)).toBe(true);
    expect(isOverdue({ status: "pending", deadlineAt: "2026-01-12T00:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "approved", deadlineAt: "2026-01-08T00:00:00Z" }, now)).toBe(false);
  });
});

describe("parseResource", () => {
  const valid = { categoryId: "2", title: "Bible app", description: "Daily reading", url: "https://example.com" };

  it("accepts a valid resource in a real category", () => {
    expect(parseResource(valid, [1, 2])).toEqual({ ok: true, value: { ...valid, categoryId: 2 } });
  });

  it("rejects unknown categories, unsafe links and blanks", () => {
    expect(parseResource(valid, [1]).ok).toBe(false);
    expect(parseResource({ ...valid, url: "javascript:alert(1)" }, [2]).ok).toBe(false);
    expect(parseResource({ ...valid, title: "" }, [2]).ok).toBe(false);
  });

  it("matches the same link written differently", () => {
    expect(normaliseUrlForMatch("https://www.Example.com/app/")).toBe(normaliseUrlForMatch("http://example.com/app"));
  });
});

describe("parseCategory", () => {
  it("derives a slug from the name", () => {
    expect(parseCategory({ name: "Worship & Prayer" }).value).toMatchObject({ slug: "worship-prayer", sortOrder: 0, description: null });
  });

  it("requires a name", () => {
    expect(parseCategory({ name: "" }).ok).toBe(false);
  });
});

describe("permission holders", () => {
  const NODE = "zander.web.resources.review";
  const groupPermissions = [
    { name: "moderator", permission: NODE },
    { name: "admin", permission: "group.moderator" },
    { name: "owner", permission: "*" },
    { name: "helper", permission: "zander.web.events" },
    { name: "loop-a", permission: "group.loop-b" },
    { name: "loop-b", permission: "group.loop-a" },
  ];

  it("follows inheritance and wildcards, and survives loops", () => {
    expect([...findGrantingGroups(NODE, groupPermissions)].sort()).toEqual(["admin", "moderator", "owner"]);
  });

  it("finds users by direct node, group and primary group", () => {
    const holders = findPermissionHolders(NODE, {
      groupPermissions,
      userPermissions: [
        { uuid: "AAAA-1", permission: "group.admin" },
        { uuid: "bbbb2", permission: "zander.web.*" },
        { uuid: "cccc3", permission: "group.helper" },
        { uuid: "dddd4", permission: "group.helper" },
      ],
      primaryGroups: [
        { uuid: "dddd4", primary_group: "moderator" }, // has group rows, so primary is ignored
        { uuid: "eeee5", primary_group: "moderator" },
      ],
    });
    expect([...holders].sort()).toEqual(["aaaa1", "bbbb2", "eeee5"]);
  });

  it("lists the node and the wildcards that grant it", () => {
    expect(grantingNodes("zander.web.x")).toEqual(["*", "zander.*", "zander.web.*", "zander.web.x.*", "zander.web.x"]);
  });
});
