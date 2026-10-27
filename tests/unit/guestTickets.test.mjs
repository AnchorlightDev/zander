import { describe, expect, it } from "vitest";
import { guestDisplayName, guestTicketToken, guestTicketUrl, isValidGuestTicketToken } from "../../lib/guestTickets.mjs";

const env = { sessionCookieSecret: "test-secret" };

describe("guest ticket links", () => {
  it("accept the token for their own ticket and email", () => {
    const token = guestTicketToken(42, "steve@example.com", env);
    expect(isValidGuestTicketToken(42, "steve@example.com", token, env)).toBe(true);
    expect(isValidGuestTicketToken(42, "  STEVE@example.com ", token, env)).toBe(true);
  });

  it("refuse another ticket, another email, a changed secret or junk", () => {
    const token = guestTicketToken(42, "steve@example.com", env);
    expect(isValidGuestTicketToken(43, "steve@example.com", token, env)).toBe(false);
    expect(isValidGuestTicketToken(42, "alex@example.com", token, env)).toBe(false);
    expect(isValidGuestTicketToken(42, "steve@example.com", token, { sessionCookieSecret: "other" })).toBe(false);
    expect(isValidGuestTicketToken(42, "steve@example.com", "short", env)).toBe(false);
    expect(isValidGuestTicketToken(42, "steve@example.com", undefined, env)).toBe(false);
    expect(isValidGuestTicketToken(42, null, token, env)).toBe(false);
  });

  it("are URL-safe and point at the private page", () => {
    const url = guestTicketUrl("https://example.com/", 42, "steve@example.com", env);
    expect(url).toMatch(/^https:\/\/example\.com\/contact\/ticket\/42\/[A-Za-z0-9_-]+$/);
  });

  it("refuse to sign without a secret", () => {
    expect(() => guestTicketToken(1, "a@b.co", {})).toThrow(/sessionCookieSecret/);
  });
});

describe("guestDisplayName", () => {
  it("labels guests clearly", () => {
    expect(guestDisplayName({ guestName: "Steve" })).toBe("Steve (guest)");
    expect(guestDisplayName({})).toBe("Guest");
  });
});
