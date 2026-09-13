import { describe, it, expect } from "vitest";
import { hasPermission } from "../../lib/discord/permissions.mjs";

describe("hasPermission", () => {
  it("returns false for empty permissions array", () => {
    expect(hasPermission([], "zander.web.finance")).toBe(false);
  });

  it("returns false for null/undefined permissions", () => {
    expect(hasPermission(null, "zander.web.finance")).toBe(false);
    expect(hasPermission(undefined, "zander.web.finance")).toBe(false);
  });

  it("returns false for empty node", () => {
    expect(hasPermission(["zander.web.finance"], "")).toBe(false);
    expect(hasPermission(["zander.web.finance"], null)).toBe(false);
  });

  it("grants access for exact match", () => {
    expect(hasPermission(["zander.web.finance"], "zander.web.finance")).toBe(true);
  });

  it("grants access with wildcard *", () => {
    expect(hasPermission(["*"], "zander.web.finance")).toBe(true);
    expect(hasPermission(["*"], "zander.web.events.review")).toBe(true);
  });

  it("grants access with prefix wildcard zander.*", () => {
    expect(hasPermission(["zander.*"], "zander.web.finance")).toBe(true);
    expect(hasPermission(["zander.*"], "zander.web.events")).toBe(true);
  });

  it("grants access with mid-level wildcard zander.web.*", () => {
    expect(hasPermission(["zander.web.*"], "zander.web.finance")).toBe(true);
    expect(hasPermission(["zander.web.*"], "zander.web.events.review")).toBe(true);
  });

  it("denies access when wildcard prefix does not match", () => {
    expect(hasPermission(["zander.web.*"], "other.module.read")).toBe(false);
  });

  it("denies access for sub-node when only parent is granted without wildcard", () => {
    expect(hasPermission(["zander.web.finance"], "zander.web.finance.manage")).toBe(false);
  });

  it("grants access for sub-node with wildcard", () => {
    expect(hasPermission(["zander.web.finance.*"], "zander.web.finance.manage")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasPermission(["ZANDER.WEB.FINANCE"], "zander.web.finance")).toBe(true);
    expect(hasPermission(["zander.web.finance"], "ZANDER.WEB.FINANCE")).toBe(true);
  });

  it("grants access if any permission in the list matches", () => {
    expect(hasPermission(["zander.web.events", "zander.web.finance"], "zander.web.finance")).toBe(true);
  });

  it("grants wildcard node access to itself (zander.web.finance.* includes zander.web.finance)", () => {
    expect(hasPermission(["zander.web.finance.*"], "zander.web.finance")).toBe(true);
  });
});
