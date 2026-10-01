import { describe, it, expect } from "vitest";
import { needsVerificationReminder } from "../../lib/discord/unverifiedReminder.mjs";

const VERIFIED = "111";

function member(id, roleIds = [], bot = false) {
  const roles = new Map([["everyone", {}], ...roleIds.map((r) => [r, {}])]);
  return { id, user: { bot }, roles: { cache: roles } };
}

describe("needsVerificationReminder", () => {
  it("skips members linked to a website account even without the verified role", () => {
    expect(needsVerificationReminder(member("42", ["member"]), new Set(["42"]), VERIFIED)).toBe(false);
  });

  it("skips members holding the verified role", () => {
    expect(needsVerificationReminder(member("42", [VERIFIED]), new Set(), VERIFIED)).toBe(false);
  });

  it("skips bots and members with only @everyone", () => {
    expect(needsVerificationReminder(member("42", ["member"], true), new Set(), VERIFIED)).toBe(false);
    expect(needsVerificationReminder(member("42"), new Set(), VERIFIED)).toBe(false);
  });

  it("reminds unlinked members with roles, with or without a verified role configured", () => {
    expect(needsVerificationReminder(member("42", ["member"]), new Set(["7"]), VERIFIED)).toBe(true);
    expect(needsVerificationReminder(member("42", ["member"]), new Set(), "")).toBe(true);
  });
});
