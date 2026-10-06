import { describe, expect, it } from "vitest";
import { isSafeLocalPath } from "../../lib/safeLocalPath.mjs";

describe("isSafeLocalPath", () => {
  it("accepts paths on this site", () => {
    expect(isSafeLocalPath("/")).toBe(true);
    expect(isSafeLocalPath("/forums/general?page=2")).toBe(true);
  });

  it("refuses anything that leaves the site", () => {
    expect(isSafeLocalPath("https://evil.example")).toBe(false);
    expect(isSafeLocalPath("//evil.example")).toBe(false);
    expect(isSafeLocalPath("/\\evil.example")).toBe(false);
    expect(isSafeLocalPath("javascript:alert(1)")).toBe(false);
  });

  it("refuses header injection and non-strings", () => {
    expect(isSafeLocalPath("/ok\r\nSet-Cookie: x=1")).toBe(false);
    expect(isSafeLocalPath(undefined)).toBe(false);
    expect(isSafeLocalPath(["/"])).toBe(false);
  });
});
