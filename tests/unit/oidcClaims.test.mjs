import { describe, expect, it } from "vitest";
import { buildClaims } from "../../lib/oidc/claims.mjs";

const user = { userId: 123, username: "Steve", discordId: "987654321012345678" };
const groups = ["moderator", "staff"];

describe("buildClaims (OIDC claim mapping)", () => {
  it("always includes sub as the CFC user ID (string)", () => {
    const claims = buildClaims(user, groups, "openid");
    expect(claims.sub).toBe("123");
  });

  it("omits preferred_username and groups unless their scopes are granted", () => {
    const claims = buildClaims(user, groups, "openid");
    expect(claims.preferred_username).toBeUndefined();
    expect(claims.groups).toBeUndefined();
  });

  it("includes preferred_username when the profile scope is granted", () => {
    const claims = buildClaims(user, groups, "openid profile");
    expect(claims.preferred_username).toBe("Steve");
  });

  it("includes effective groups when the groups scope is granted", () => {
    const claims = buildClaims(user, groups, "openid groups");
    expect(claims.groups).toEqual(["moderator", "staff"]);
  });

  it("includes discord_id only when the account is linked", () => {
    expect(buildClaims(user, groups, "openid").discord_id).toBe("987654321012345678");
    const unlinked = { userId: 5, username: "Alex", discordId: null };
    expect(buildClaims(unlinked, groups, "openid profile groups").discord_id).toBeUndefined();
  });

  it("returns groups as an empty array when none resolved but scope granted", () => {
    expect(buildClaims(user, null, "openid groups").groups).toEqual([]);
  });

  it("produces the full claim set for the Compass scopes", () => {
    const claims = buildClaims(user, groups, "openid profile groups offline_access");
    expect(claims).toEqual({
      sub: "123",
      preferred_username: "Steve",
      groups: ["moderator", "staff"],
      discord_id: "987654321012345678",
    });
  });
});
