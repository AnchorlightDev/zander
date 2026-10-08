import { describe, it, expect } from "vitest";
import { isCrossSiteRequest } from "../../lib/securityConfig.js";

const SITE = "https://example.test";
const req = (headers) => ({ headers });

describe("isCrossSiteRequest", () => {
  it("trusts Sec-Fetch-Site when the browser sends it", () => {
    expect(isCrossSiteRequest(req({ "sec-fetch-site": "same-origin" }), SITE)).toBe(false);
    expect(isCrossSiteRequest(req({ "sec-fetch-site": "none" }), SITE)).toBe(false);
    expect(isCrossSiteRequest(req({ "sec-fetch-site": "cross-site", origin: SITE }), SITE)).toBe(true);
    expect(isCrossSiteRequest(req({ "sec-fetch-site": "same-site" }), SITE)).toBe(true);
  });

  it("falls back to Origin, then Referer", () => {
    expect(isCrossSiteRequest(req({ origin: SITE }), SITE)).toBe(false);
    expect(isCrossSiteRequest(req({ origin: "https://evil.test" }), SITE)).toBe(true);
    expect(isCrossSiteRequest(req({ referer: `${SITE}/dashboard` }), SITE)).toBe(false);
    expect(isCrossSiteRequest(req({ referer: "https://evil.test/x" }), SITE)).toBe(true);
    expect(isCrossSiteRequest(req({ referer: "not a url" }), SITE)).toBe(true);
  });

  it("lets header-less clients through and never locks out a misconfigured site", () => {
    expect(isCrossSiteRequest(req({}), SITE)).toBe(false);
    expect(isCrossSiteRequest(req({ origin: "https://evil.test" }), undefined)).toBe(false);
  });
});
