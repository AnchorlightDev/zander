import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveTrustProxy, parseTrustProxyHops } from "../../lib/trustProxy.mjs";
import { resolveEffectiveNodes } from "../../lib/permissions/resolveNodes.mjs";
import {
  isPublicPasswordResetEligible,
  webLoginBlockReason,
} from "../../controllers/userAccountState.js";
import { SessionCache } from "../../lib/sessionCache.mjs";

describe("resolveTrustProxy", () => {
  it("never trusts every hop on https (req.ip must not be the client-written XFF entry)", () => {
    const { trustProxy, hops } = resolveTrustProxy(undefined, true);
    expect(hops).toBe(1);
    expect(typeof trustProxy).toBe("function");
    expect(trustProxy("10.0.0.1", 0)).toBe(true); // socket peer: honours X-Forwarded-Proto
    expect(trustProxy("1.2.3.4", 1)).toBe(false); // client-supplied entries are not walked
  });

  it("honours an explicit hop count and disables trust on plain http", () => {
    expect(resolveTrustProxy("2", true).hops).toBe(2);
    expect(resolveTrustProxy("2", true).trustProxy("x", 1)).toBe(true);
    expect(resolveTrustProxy("2", true).trustProxy("x", 2)).toBe(false);
    expect(resolveTrustProxy(undefined, false)).toEqual({ trustProxy: false, hops: 0 });
    expect(resolveTrustProxy("0", true)).toEqual({ trustProxy: false, hops: 0 });
  });

  it("ignores junk values", () => {
    expect(parseTrustProxyHops("true")).toBeNull();
    expect(parseTrustProxyHops("1.5")).toBeNull();
    expect(parseTrustProxyHops("")).toBeNull();
  });
});

describe("resolveEffectiveNodes", () => {
  const known = ["zander.web.settings", "zander.web.ranks", "zander.web.dashboard", "zander.web.finance.*"];

  it("a user-level negation beats a group wildcard", () => {
    const nodes = resolveEffectiveNodes({
      userNodes: [{ permission: "zander.web.settings", value: 0 }],
      groupNodes: [{ permission: "zander.web.*", value: 1 }],
      knownNodes: known,
    });
    expect(nodes).not.toContain("zander.web.*");
    expect(nodes).not.toContain("zander.web.settings");
    expect(nodes).toEqual(expect.arrayContaining(["zander.web.ranks", "zander.web.dashboard"]));
  });

  it("a user-level grant beats a group negation of the same node", () => {
    const nodes = resolveEffectiveNodes({
      userNodes: [{ permission: "zander.web.settings", value: 1 }],
      groupNodes: [{ permission: "zander.web.settings", value: 0 }],
    });
    expect(nodes).toEqual(["zander.web.settings"]);
  });

  it("an exact grant beats a broader negated wildcard", () => {
    const nodes = resolveEffectiveNodes({
      groupNodes: [
        { permission: "zander.web.*", value: 0 },
        { permission: "zander.web.ranks", value: 1 },
      ],
    });
    expect(nodes).toEqual(["zander.web.ranks"]);
  });

  it("keeps a wildcard untouched when nothing under it is negated", () => {
    expect(resolveEffectiveNodes({ groupNodes: [{ permission: "zander.web.*", value: 1 }] })).toEqual(["zander.web.*"]);
  });

  it("keeps * when the only negation is an unrelated game node", () => {
    const nodes = resolveEffectiveNodes({
      groupNodes: [
        { permission: "*", value: 1 },
        { permission: "essentials.fly", value: 0 },
      ],
      knownNodes: known,
    });
    expect(nodes).toEqual(["*"]);
  });
});

describe("account gates", () => {
  it("public reset needs a verified email and an enabled account", () => {
    const base = { email: "a@b.c", password_hash: "h", email_verified: 1, account_disabled: 0 };
    expect(isPublicPasswordResetEligible(base)).toBe(true);
    expect(isPublicPasswordResetEligible({ ...base, email_verified: 0 })).toBe(false);
    expect(isPublicPasswordResetEligible({ ...base, account_disabled: 1 })).toBe(false);
    expect(isPublicPasswordResetEligible(null)).toBe(false);
  });

  it("web login refuses missing, placeholder and disabled rows", () => {
    expect(webLoginBlockReason(null)).toBe("missing");
    expect(webLoginBlockReason({ is_placeholder: 1 })).toBe("placeholder");
    expect(webLoginBlockReason({ account_disabled: 1 })).toBe("disabled");
    expect(webLoginBlockReason({ is_placeholder: 0, account_disabled: 0 })).toBeNull();
  });
});

describe("SessionCache.deleteForUser", () => {
  it("evicts only that user's sessions", () => {
    const cache = new SessionCache();
    cache.set("a", { user: { userId: 7 } });
    cache.set("b", { user: { userId: 8 } });
    cache.set("c", { returnTo: "/x" });
    expect(cache.deleteForUser("7")).toBe(1);
    expect(cache.fresh("a")).toBeUndefined();
    expect(cache.fresh("b")).toEqual({ user: { userId: 8 } });
    expect(cache.fresh("c")).toEqual({ returnTo: "/x" });
  });
});
