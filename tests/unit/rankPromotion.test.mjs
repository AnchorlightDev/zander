import { describe, it, expect } from "vitest";
import { isAboveHighestRank, isSameUser } from "../../lib/rankPromotion.mjs";

describe("isSameUser", () => {
  it("matches on userId", () => {
    expect(isSameUser({ userId: 7 }, { userId: "7" })).toBe(true);
  });

  it("matches on uuid, ignoring case", () => {
    expect(isSameUser({ uuid: "ABC-1" }, { userId: 9, uuid: "abc-1" })).toBe(true);
  });

  it("does not match different people or missing identities", () => {
    expect(isSameUser({ userId: 1, uuid: "a" }, { userId: 2, uuid: "b" })).toBe(false);
    expect(isSameUser({}, {})).toBe(false);
    expect(isSameUser({ uuid: "" }, { uuid: "" })).toBe(false);
  });
});

describe("isAboveHighestRank", () => {
  it("blocks a rank that outweighs everything held", () => {
    expect(isAboveHighestRank(100, [10, 50])).toBe(true);
  });

  it("allows a rank at or below the highest held", () => {
    expect(isAboveHighestRank(50, [10, 50])).toBe(false);
    expect(isAboveHighestRank(5, [10, 50])).toBe(false);
  });

  it("treats unset weights as 0", () => {
    expect(isAboveHighestRank(null, [])).toBe(false);
    expect(isAboveHighestRank(1, [null])).toBe(true);
  });
});
