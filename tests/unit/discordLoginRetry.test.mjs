import { describe, expect, it } from "vitest";
import { LOGIN_RETRY_MAX_MS, isFatalLoginError, nextLoginDelayMs } from "../../lib/discord/loginRetry.mjs";

describe("Discord login retry", () => {
  it("backs off exponentially from 5s, capped at 5 minutes", () => {
    expect(nextLoginDelayMs(1)).toBe(5_000);
    expect(nextLoginDelayMs(2)).toBe(10_000);
    expect(nextLoginDelayMs(4)).toBe(40_000);
    expect(nextLoginDelayMs(50)).toBe(LOGIN_RETRY_MAX_MS);
  });

  it("retries transient gateway errors such as a 503 handshake", () => {
    expect(isFatalLoginError(new Error("Unexpected server response: 503"))).toBe(false);
    expect(isFatalLoginError({ code: "ECONNRESET" })).toBe(false);
  });

  it("gives up on a bad token or disallowed intents", () => {
    expect(isFatalLoginError({ code: "TokenInvalid" })).toBe(true);
    expect(isFatalLoginError({ code: "DisallowedIntents" })).toBe(true);
    expect(isFatalLoginError({ code: 4014 })).toBe(true);
  });
});
