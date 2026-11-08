import { describe, expect, it } from "vitest";
import {
  CONTACT_LIMITS,
  MAX_CONTACT_LINKS,
  MIN_CONTACT_FILL_SECONDS,
  countLinks,
  isDisposableEmail,
  isSubmittedTooFast,
  parseContactSubmission,
  parseGuestReply,
} from "../../lib/publicPages.mjs";
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

  it("rejects guests using a disposable email", () => {
    expect(parseContactSubmission({ ...guest, email: "spam@mailinator.com" }).ok).toBe(false);
  });

  it("rejects messages that flood links", () => {
    const linky = Array.from({ length: MAX_CONTACT_LINKS + 1 }, (_, i) => `https://spam${i}.xyz`).join(" ");
    expect(parseContactSubmission({ ...guest, message: linky }).ok).toBe(false);
    // A couple of links is fine.
    expect(parseContactSubmission({ ...guest, message: "see https://example.com here" }).ok).toBe(true);
  });
});

describe("spam heuristics", () => {
  it("counts http(s), www and bare-domain links", () => {
    expect(countLinks("plain text with none")).toBe(0);
    expect(countLinks("visit https://a.com and www.b.net and c.shop")).toBe(3);
  });

  it("flags only known disposable email domains", () => {
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@gmail.com")).toBe(false);
    expect(isDisposableEmail("")).toBe(false);
  });

  it("treats near-instant submissions as bots, but allows missing/old stamps", () => {
    const now = 1_000_000_000;
    expect(isSubmittedTooFast(now - 500, now)).toBe(true); // half a second
    expect(isSubmittedTooFast(now - (MIN_CONTACT_FILL_SECONDS + 5) * 1000, now)).toBe(false);
    expect(isSubmittedTooFast(now + 5000, now)).toBe(true); // future timestamp = tampering
    expect(isSubmittedTooFast(undefined, now)).toBe(false); // missing = don't false-positive
    expect(isSubmittedTooFast("garbage", now)).toBe(false);
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
