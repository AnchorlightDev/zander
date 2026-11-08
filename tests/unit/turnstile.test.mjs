import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTurnstileEnabled, turnstileSiteKey, verifyTurnstileToken } from "../../lib/turnstile.mjs";

const ORIGINAL = { site: process.env.TURNSTILE_SITE_KEY, secret: process.env.TURNSTILE_SECRET_KEY };

function setKeys({ site, secret }) {
  if (site === undefined) delete process.env.TURNSTILE_SITE_KEY;
  else process.env.TURNSTILE_SITE_KEY = site;
  if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = secret;
}

beforeEach(() => setKeys({ site: undefined, secret: undefined }));
afterEach(() => setKeys({ site: ORIGINAL.site, secret: ORIGINAL.secret }));

describe("turnstile configuration", () => {
  it("is disabled until both keys are present", () => {
    expect(isTurnstileEnabled()).toBe(false);
    setKeys({ site: "1x00000000000000000000AA", secret: undefined });
    expect(isTurnstileEnabled()).toBe(false);
    setKeys({ site: "1x00000000000000000000AA", secret: "secret" });
    expect(isTurnstileEnabled()).toBe(true);
    expect(turnstileSiteKey()).toBe("1x00000000000000000000AA");
  });
});

describe("verifyTurnstileToken", () => {
  it("skips (soft pass) when unconfigured, without calling the network", async () => {
    const fetchSpy = vi.fn();
    const result = await verifyTurnstileToken("tok", null, fetchSpy);
    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails fast on an empty token when enabled", async () => {
    setKeys({ site: "s", secret: "x" });
    const fetchSpy = vi.fn();
    const result = await verifyTurnstileToken("", null, fetchSpy);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes when Cloudflare reports success", async () => {
    setKeys({ site: "s", secret: "x" });
    const fetchSpy = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) });
    const result = await verifyTurnstileToken("good-token", "1.2.3.4", fetchSpy);
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("fails when Cloudflare reports failure", async () => {
    setKeys({ site: "s", secret: "x" });
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    const result = await verifyTurnstileToken("bad-token", null, fetchSpy);
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("invalid-input-response");
  });

  it("soft-passes if the verifier is unreachable, so an outage can't wedge the form", async () => {
    setKeys({ site: "s", secret: "x" });
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await verifyTurnstileToken("token", null, fetchSpy);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });
});
