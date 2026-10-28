import { describe, expect, it } from "vitest";
import { isSafeLocalPath, toSafeLocalPath } from "../../lib/safeLocalPath.mjs";

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

  it("refuses control characters browsers strip before resolving", () => {
    // Browsers delete tabs and newlines from URLs, turning these into //evil.example.
    expect(isSafeLocalPath("/\t/evil.example")).toBe(false);
    expect(isSafeLocalPath("/\n/evil.example")).toBe(false);
    expect(isSafeLocalPath("/a\\..\\..\\/evil")).toBe(false);
  });

  it("refuses header injection and non-strings", () => {
    expect(isSafeLocalPath("/ok\r\nSet-Cookie: x=1")).toBe(false);
    expect(isSafeLocalPath(undefined)).toBe(false);
    expect(isSafeLocalPath(["/"])).toBe(false);
  });
});

describe("toSafeLocalPath", () => {
  it("returns the path, query and fragment of a same-site path", () => {
    expect(toSafeLocalPath("/forums/general?page=2#top")).toBe("/forums/general?page=2#top");
    expect(toSafeLocalPath("/")).toBe("/");
  });

  it("returns the fallback for anything else", () => {
    for (const value of ["//evil.example", "/\t/evil.example", "https://evil.example", "", null, 42]) {
      expect(toSafeLocalPath(value, "/home")).toBe("/home");
    }
    expect(toSafeLocalPath("//evil.example")).toBeNull();
  });
});
