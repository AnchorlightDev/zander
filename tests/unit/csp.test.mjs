import { describe, it, expect } from "vitest";
import {
  generateNonce,
  buildContentSecurityPolicy,
  injectNonce,
  isHtmlResponse,
  CSP_SOURCES,
} from "../../lib/csp.js";

describe("generateNonce", () => {
  it("returns 128 bits of base64", () => {
    const nonce = generateNonce();
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
  });

  it("is different on every call", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(seen.size).toBe(200);
  });
});

describe("buildContentSecurityPolicy", () => {
  const policy = buildContentSecurityPolicy("NONCE123", { reportUri: "/api/csp-report" });
  const directive = (name) =>
    policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("binds script-src to the request nonce", () => {
    expect(directive("script-src")).toContain("'nonce-NONCE123'");
  });

  it("does not allow unsafe-inline script, which would defeat the policy", () => {
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
  });

  it("keeps unsafe-inline for style only", () => {
    // ~356 inline style attributes in views/; nonces cannot cover attributes.
    expect(directive("style-src")).toContain("'unsafe-inline'");
  });

  it("locks down the high-risk directives", () => {
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'self'");
  });

  it("allows every CDN the templates actually reference", () => {
    for (const host of CSP_SOURCES.script) {
      expect(directive("script-src")).toContain(host);
    }
  });

  it("includes the report endpoint when given one", () => {
    expect(policy).toContain("report-uri /api/csp-report");
  });

  it("omits report-uri when none is supplied", () => {
    expect(buildContentSecurityPolicy("N")).not.toContain("report-uri");
  });

  it("never emits a bare directive with no sources", () => {
    for (const d of policy.split("; ")) {
      expect(d.trim().split(/\s+/).length).toBeGreaterThan(1);
    }
  });
});

describe("injectNonce", () => {
  it("stamps a plain script tag", () => {
    expect(injectNonce("<script>alert(1)</script>", "N")).toBe(
      '<script nonce="N">alert(1)</script>'
    );
  });

  it("stamps a script tag that has attributes", () => {
    expect(injectNonce('<script src="/a.js" defer></script>', "N")).toBe(
      '<script nonce="N" src="/a.js" defer></script>'
    );
  });

  it("never touches the closing tag", () => {
    const out = injectNonce("<script>x</script>", "N");
    expect(out).toContain("</script>");
    expect(out).not.toContain('</script nonce');
  });

  it("is idempotent, so a double pass cannot double-stamp", () => {
    const once = injectNonce("<script>a</script><script src='b'></script>", "N");
    expect(injectNonce(once, "N")).toBe(once);
  });

  it("handles many tags and mixed casing", () => {
    const html = "<SCRIPT>a</SCRIPT><script>b</script><script src='c'></script>";
    const out = injectNonce(html, "N");
    expect(out.match(/nonce="N"/g)).toHaveLength(3);
  });

  it("leaves documents with no scripts unchanged", () => {
    const html = "<html><body><p>hello</p></body></html>";
    expect(injectNonce(html, "N")).toBe(html);
  });

  it("returns non-string payloads untouched", () => {
    const buf = Buffer.from("<script>a</script>");
    expect(injectNonce(buf, "N")).toBe(buf);
    expect(injectNonce(null, "N")).toBe(null);
  });

  it("returns the document unchanged when no nonce is supplied", () => {
    const html = "<script>a</script>";
    expect(injectNonce(html, "")).toBe(html);
  });
});

describe("isHtmlResponse", () => {
  it("matches html content types", () => {
    expect(isHtmlResponse("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlResponse("TEXT/HTML")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isHtmlResponse("application/json; charset=utf-8")).toBe(false);
    expect(isHtmlResponse("image/png")).toBe(false);
    expect(isHtmlResponse(undefined)).toBe(false);
    expect(isHtmlResponse(null)).toBe(false);
  });
});
