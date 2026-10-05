import { describe, expect, it } from "vitest";
import { CONTACT_LIMITS, parseContactSubmission } from "../../lib/publicPages.mjs";
import { staticSitemapPages } from "../../routes/sitemapRoute.js";

describe("parseContactSubmission", () => {
  const valid = { name: "Steve", email: "steve@example.com", message: "Hi there" };

  it("accepts a complete submission and trims it", () => {
    expect(parseContactSubmission({ ...valid, name: "  Steve " })).toEqual({ ok: true, value: valid });
  });

  it("rejects missing fields, bad emails and oversized messages", () => {
    expect(parseContactSubmission({ ...valid, message: "" }).ok).toBe(false);
    expect(parseContactSubmission({ ...valid, email: "not-an-email" }).ok).toBe(false);
    expect(parseContactSubmission({ ...valid, message: "x".repeat(CONTACT_LIMITS.message + 1) }).ok).toBe(false);
  });

  it("keeps messages within a Discord embed field", () => {
    expect(CONTACT_LIMITS.message).toBeLessThanOrEqual(1024);
  });
});

describe("sitemap", () => {
  const urls = (features) => staticSitemapPages(features).map((p) => p.url);

  it("follows the resources and contact flags", () => {
    expect(urls({ resources: true, contact: true })).toEqual(expect.arrayContaining(["/resources", "/contact"]));
    expect(urls({})).not.toContain("/resources");
    expect(urls({})).not.toContain("/contact");
  });
});
