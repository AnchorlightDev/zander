import { describe, expect, it } from "vitest";
import { CONTACT_LIMITS, parseContactSubmission, parseGuestReply } from "../../lib/publicPages.mjs";
import { staticSitemapPages } from "../../routes/sitemapRoute.js";

describe("parseContactSubmission", () => {
  const guest = { name: "Steve", email: "Steve@Example.com", subject: "Server question", message: "Hi there" };

  it("accepts a complete guest submission, trimmed, with the email lowercased", () => {
    expect(parseContactSubmission({ ...guest, name: "  Steve " })).toEqual({
      ok: true,
      value: { name: "Steve", email: "steve@example.com", subject: "Server question", message: "Hi there" },
    });
  });

  it("asks guests for a name and a valid email", () => {
    expect(parseContactSubmission({ ...guest, name: "" }).ok).toBe(false);
    expect(parseContactSubmission({ ...guest, email: "not-an-email" }).ok).toBe(false);
  });

  it("does not need a name or email from signed-in people", () => {
    const result = parseContactSubmission({ subject: "Hi", message: "Hello" }, { signedIn: true });
    expect(result).toEqual({ ok: true, value: { name: "", email: "", subject: "Hi", message: "Hello" } });
  });

  it("requires a subject and message within the limits", () => {
    expect(parseContactSubmission({ ...guest, subject: "" }).ok).toBe(false);
    expect(parseContactSubmission({ ...guest, subject: "x".repeat(CONTACT_LIMITS.subject + 1) }).ok).toBe(false);
    expect(parseContactSubmission({ ...guest, message: "x".repeat(CONTACT_LIMITS.message + 1) }).ok).toBe(false);
  });

  it("keeps messages within a Discord embed description", () => {
    expect(CONTACT_LIMITS.message).toBeLessThanOrEqual(4096);
  });
});

describe("parseGuestReply", () => {
  it("needs some text", () => {
    expect(parseGuestReply({ message: "  " }).ok).toBe(false);
    expect(parseGuestReply({ message: " thanks " })).toEqual({ ok: true, value: "thanks" });
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
