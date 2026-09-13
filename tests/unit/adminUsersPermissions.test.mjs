import { describe, expect, it } from "vitest";
import { hasPermissionSilent } from "../../controllers/userAccountState.js";

describe("hasPermissionSilent (Users dashboard soft permission gate)", () => {
  it("denies when permissions are missing/undefined", () => {
    expect(hasPermissionSilent("zander.web.users.email", undefined)).toBe(false);
    expect(hasPermissionSilent("zander.web.users.email", null)).toBe(false);
  });

  it("denies when permissions array is empty", () => {
    expect(hasPermissionSilent("zander.web.users.email", [])).toBe(false);
  });

  it("grants on an exact match", () => {
    expect(hasPermissionSilent("zander.web.users.email", ["zander.web.users.email"])).toBe(true);
  });

  it("denies a sub-node when only the parent node (no wildcard) is granted", () => {
    expect(hasPermissionSilent("zander.web.users.email", ["zander.web.users"])).toBe(false);
    expect(hasPermissionSilent("zander.web.users.manage", ["zander.web.users"])).toBe(false);
  });

  it("grants zander.web.users.email and .manage via a zander.web.users.* wildcard", () => {
    expect(hasPermissionSilent("zander.web.users.email", ["zander.web.users.*"])).toBe(true);
    expect(hasPermissionSilent("zander.web.users.manage", ["zander.web.users.*"])).toBe(true);
  });

  it("grants via a broader zander.web.* wildcard", () => {
    expect(hasPermissionSilent("zander.web.users.manage", ["zander.web.*"])).toBe(true);
  });

  it("grants via the global * wildcard", () => {
    expect(hasPermissionSilent("zander.web.users.manage", ["*"])).toBe(true);
  });

  it("denies an unrelated permission", () => {
    expect(hasPermissionSilent("zander.web.users.manage", ["zander.web.badges"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(hasPermissionSilent("ZANDER.WEB.USERS.EMAIL", ["zander.web.users.email"])).toBe(true);
  });
});
