import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { defaultMenus, isAllowedUrl, parseMenu, resolveMenu } from "../../lib/navigation/menus.mjs";
import { listFlagPaths } from "../../lib/config/featureRegistry.mjs";

const require = createRequire(import.meta.url);
const { DEFAULT_FEATURES } = require("../../lib/config/defaults.cjs");
const featurePaths = listFlagPaths(DEFAULT_FEATURES);

describe("isAllowedUrl", () => {
  it("allows site paths, http(s) and mailto", () => {
    expect(isAllowedUrl("/rules")).toBe(true);
    expect(isAllowedUrl("https://example.com")).toBe(true);
    expect(isAllowedUrl("mailto:hi@example.com")).toBe(true);
  });

  it("refuses script links and protocol-relative paths", () => {
    expect(isAllowedUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedUrl("//evil.example")).toBe(false);
    expect(isAllowedUrl("/\\evil.example")).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
  });
});

describe("defaultMenus", () => {
  it("only uses module switches that exist", () => {
    const menus = defaultMenus({});
    const used = [];
    const walk = (items) => items.forEach((i) => { if (i.feature) used.push(i.feature); walk(i.children || []); });
    Object.values(menus).forEach(walk);
    for (const flag of used) expect(featurePaths, flag).toContain(flag);
  });

  it("passes its own validation", () => {
    const menus = defaultMenus({ siteConfiguration: { email: "a@b.co", platforms: { discord: "https://discord.gg/x" } } });
    for (const [location, items] of Object.entries(menus)) {
      const result = parseMenu(location, items, { featurePaths });
      expect(result.errors, location).toBeUndefined();
    }
  });

  it("leaves email and Discord out of the top bar until they are set", () => {
    const labels = defaultMenus({}).topbar.map((i) => i.type);
    expect(labels).toEqual(["server", "server"]);
  });
});

describe("parseMenu", () => {
  it("rejects unknown locations and non-arrays", () => {
    expect(parseMenu("sidebar", []).ok).toBe(false);
    expect(parseMenu("header", "nope").ok).toBe(false);
  });

  it("strips unknown fields", () => {
    const result = parseMenu("header", [{ type: "link", label: "Home", url: "/", onclick: "x" }], { featurePaths });
    expect(result.items).toEqual([{ type: "link", label: "Home", url: "/" }]);
  });

  it("enforces structure per location", () => {
    expect(parseMenu("footer", [{ type: "link", label: "Loose", url: "/" }]).ok).toBe(false);
    expect(parseMenu("topbar", [{ type: "heading", label: "H" }]).ok).toBe(false);
    expect(parseMenu("header", [{ type: "link", label: "L", url: "/", children: [{ type: "link", label: "C", url: "/" }] }]).ok).toBe(false);
    expect(parseMenu("header", [{ type: "heading", label: "H", children: [{ type: "heading", label: "N" }] }]).ok).toBe(false);
  });

  it("validates links, icons and modules", () => {
    expect(parseMenu("header", [{ type: "link", label: "X", url: "javascript:alert(1)" }]).ok).toBe(false);
    expect(parseMenu("header", [{ type: "link", label: "X", url: "/", icon: "fa-solid\" onmouseover=\"x" }]).ok).toBe(false);
    expect(parseMenu("header", [{ type: "link", label: "X", url: "/", feature: "nope" }], { featurePaths }).ok).toBe(false);
    expect(parseMenu("header", [{ type: "link", label: "X", url: "/", feature: "forums" }], { featurePaths }).ok).toBe(true);
  });
});

describe("resolveMenu", () => {
  const items = [
    { type: "link", label: "Home", url: "/" },
    { type: "link", label: "Forums", url: "/forums", feature: "forums" },
    { type: "page", label: "About", pageId: 3 },
    { type: "page", label: "Gone", pageId: 99 },
    { type: "link", label: "Login", url: "/login", visibility: "guests" },
    { type: "link", label: "Profile", url: "/profile", visibility: "members" },
    { type: "heading", label: "Empty", children: [{ type: "link", label: "Off", url: "/x", feature: "events" }] },
    { type: "server", label: "Java", edition: "java" },
    { type: "server", label: "Bedrock", edition: "bedrock" },
  ];
  const ctx = {
    features: { forums: true, events: false },
    pageSlugs: new Map([[3, "about"]]),
    addresses: { java: "play.example.com", bedrock: null },
    currentPath: "/forums/general",
  };

  it("hides what the visitor should not see", () => {
    const labels = resolveMenu(items, ctx).map((i) => i.label);
    expect(labels).toEqual(["Home", "Forums", "About", "Login", "play.example.com"]);
  });

  it("swaps guest and member links when logged in", () => {
    const labels = resolveMenu(items, { ...ctx, loggedIn: true }).map((i) => i.label);
    expect(labels).toContain("Profile");
    expect(labels).not.toContain("Login");
  });

  it("marks the current section active", () => {
    const resolved = resolveMenu(items, ctx);
    expect(resolved.find((i) => i.label === "Forums").active).toBe(true);
    expect(resolved.find((i) => i.label === "Home").active).toBe(false);
    expect(resolved.find((i) => i.label === "About").url).toBe("/about");
  });
});
