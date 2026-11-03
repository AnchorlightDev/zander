import { describe, expect, it } from "vitest";
import { classifyStaffGrants } from "../../lib/permissions/effectiveGroups.mjs";
import { explainDenial } from "../../lib/oidc/denial.mjs";
import { cleanStaffGroups, resolveStaffGroups } from "../../lib/oidc/staffGroups.mjs";

const STAFF = ["staff", "eventstaff", "moderator"];
const NOW = 1_800_000_000;

describe("classifyStaffGrants", () => {
  it("reports a staff rank granted only on one server", () => {
    const rows = [
      { slug: "eventstaff", server: "survival", world: "global", value: 1, expiry: 0 },
      { slug: "gold", server: "global", world: "global", value: 1, expiry: 0 },
    ];
    expect(classifyStaffGrants(rows, STAFF, NOW)).toEqual([
      { group: "eventstaff", problem: "context", server: "survival", world: "global" },
    ]);
  });

  it("reports expired and negated staff ranks", () => {
    const rows = [
      { slug: "moderator", server: "global", world: "global", value: 1, expiry: NOW - 10 },
      { slug: "staff", server: "global", world: "global", value: 0, expiry: 0 },
    ];
    expect(classifyStaffGrants(rows, STAFF, NOW)).toEqual([
      { group: "moderator", problem: "expired", expiredAt: NOW - 10 },
      { group: "staff", problem: "negated" },
    ]);
  });

  it("ignores a rank that also has a valid global grant, and non-staff ranks", () => {
    const rows = [
      { slug: "eventstaff", server: "survival", world: "global", value: 1, expiry: 0 },
      { slug: "eventstaff", server: "global", world: "global", value: 1, expiry: 0 },
      { slug: "gold", server: "hub", world: "global", value: 1, expiry: 0 },
    ];
    expect(classifyStaffGrants(rows, STAFF, NOW)).toEqual([]);
  });
});

describe("explainDenial", () => {
  it("explains a context-only grant with the fix command", () => {
    const out = explainDenial({
      reason: "not_staff",
      user: { username: "Adorielle" },
      groups: ["default", "gold"],
      issues: [{ group: "eventstaff", problem: "context", server: "survival", world: "global" }],
    });
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain('only on server "survival"');
    expect(out.reasons[0]).toContain("/lp user Adorielle parent add eventstaff");
    expect(out.footer).toContain("Adorielle");
  });

  it("lists the ranks found when nothing explains it", () => {
    const out = explainDenial({ reason: "not_staff", user: { username: "x" }, groups: ["default", "gold"], issues: [] });
    expect(out.reasons[0]).toBe("Ranks found on your account: gold. None of them are allowed to sign in to Compass.");
  });

  it("covers disabled and missing accounts", () => {
    expect(explainDenial({ reason: "account_disabled", user: { username: "x" } }).summary).toContain("disabled");
    expect(explainDenial({ reason: "no_account" }).summary).toContain("couldn't find");
  });
});

describe("staff group list", () => {
  it("cleans submitted slugs", () => {
    expect(cleanStaffGroups([" Staff ", "eventstaff", "staff", ""])).toEqual(["staff", "eventstaff"]);
    expect(cleanStaffGroups(["bad slug"])).toBeNull();
    expect(cleanStaffGroups("staff")).toBeNull();
  });

  it("prefers the list Compass sent, else the config fallback", () => {
    expect(resolveStaffGroups({ groups: ["eventstaff"], updatedBy: "shadowolfyt" }, ["staff"])).toMatchObject({
      groups: ["eventstaff"], source: "compass", updatedBy: "shadowolfyt",
    });
    expect(resolveStaffGroups(null, ["staff"])).toMatchObject({ groups: ["staff"], source: "zander" });
    expect(resolveStaffGroups({ groups: [] }, ["staff"]).source).toBe("zander");
  });
});
