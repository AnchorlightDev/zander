import { describe, it, expect } from "vitest";
import { buildInteractionPolicy, requireZanderSessionCheck } from "../../lib/oidc/policy.mjs";

describe("OIDC interaction policy", () => {
  it("asks for the interaction even when a provider session exists", () => {
    expect(requireZanderSessionCheck({ oidc: { session: { accountId: "1" } } })).toBe(true);
  });

  it("does not loop on the resume right after the interaction logged in", () => {
    expect(requireZanderSessionCheck({ oidc: { result: { login: { accountId: "1" } } } })).toBe(false);
  });

  it("adds the check to the login prompt", () => {
    const policy = buildInteractionPolicy();
    expect(policy.get("login").checks.get("zander_session")).toBeTruthy();
  });
});
