import { describe, it, expect } from "vitest";
import { grantingPermissionStrings } from "../../services/rankMetaService.js";
import { permissionMatch } from "../../controllers/forumController.js";

/**
 * A forum category stores a permission node; the locked page needs a rank
 * name. grantingPermissionStrings() is the bridge, so it has to agree exactly
 * with the matcher the access check itself uses — if it returns a narrower
 * set, a supporter board silently falls back to a 404.
 */
describe("grantingPermissionStrings", () => {
  it("includes the exact node", () => {
    expect(grantingPermissionStrings("zander.web.forums.supporter")).toContain(
      "zander.web.forums.supporter"
    );
  });

  it("includes the global wildcard", () => {
    expect(grantingPermissionStrings("zander.web.forums.supporter")).toContain("*");
  });

  it("includes every strict ancestor wildcard", () => {
    const out = grantingPermissionStrings("zander.web.forums.supporter");
    expect(out).toContain("zander.*");
    expect(out).toContain("zander.web.*");
    expect(out).toContain("zander.web.forums.*");
  });

  it("excludes the node's own descendant wildcard", () => {
    // permissionMatch strips only the "*" and tests startsWith, so
    // "a.b.c.*" does not grant "a.b.c" -- listing it would name a rank that
    // the forum access check would still turn away.
    const node = "zander.web.forums.supporter";
    expect(grantingPermissionStrings(node)).not.toContain(`${node}.*`);
    expect(permissionMatch([`${node}.*`], node)).toBe(false);
  });

  it("lower-cases and trims, since LuckPerms groups are matched case-insensitively", () => {
    expect(grantingPermissionStrings("  Zander.Web.Forums  ")).toContain("zander.web.forums");
  });

  it("handles a single-segment node", () => {
    expect(grantingPermissionStrings("supporter").sort()).toEqual(["*", "supporter"]);
  });

  it("returns nothing for an empty node, which grants everyone access anyway", () => {
    expect(grantingPermissionStrings("")).toEqual([]);
    expect(grantingPermissionStrings(null)).toEqual([]);
    expect(grantingPermissionStrings(undefined)).toEqual([]);
    expect(grantingPermissionStrings("   ")).toEqual([]);
  });

  it("does not repeat itself", () => {
    const out = grantingPermissionStrings("a.b");
    expect(new Set(out).size).toBe(out.length);
  });

  // The real contract: anything this returns must actually satisfy the
  // matcher used by userCanViewCategory, and nothing that satisfies the
  // matcher should be missing from it.
  describe("agrees with permissionMatch", () => {
    const node = "zander.web.forums.supporter";

    it("every string it returns does grant the node", () => {
      for (const candidate of grantingPermissionStrings(node)) {
        expect(permissionMatch([candidate], node)).toBe(true);
      }
    });

    it("rejects near misses that do not grant the node", () => {
      const candidates = grantingPermissionStrings(node);
      for (const other of [
        "zander.web.forum.*",
        "zander.web.forums.staff",
        "zander.webforums.*",
        "other.*",
      ]) {
        expect(candidates).not.toContain(other);
        expect(permissionMatch([other], node)).toBe(false);
      }
    });
  });
});
