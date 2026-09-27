import { describe, it, expect } from "vitest";
import { hasStaffFlag } from "../../lib/permissions/staffFlag.mjs";

describe("hasStaffFlag", () => {
  it("is true only for meta.staff.1", () => {
    expect(hasStaffFlag(["zander.web.dashboard", "meta.staff.1"])).toBe(true);
    expect(hasStaffFlag([" META.STAFF.1 "])).toBe(true);
  });

  it("is false for a non-staff rank's meta.staff.0", () => {
    expect(hasStaffFlag(["meta.staff.0", "meta.donator.1"])).toBe(false);
  });

  it("is false for anything that is not a list", () => {
    expect(hasStaffFlag(undefined)).toBe(false);
    expect(hasStaffFlag("meta.staff.1")).toBe(false);
  });
});
