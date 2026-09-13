import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  isHttpsDeployment,
  buildHelmetOptions,
  buildSessionCookieOptions,
} from "../../lib/securityConfig.js";

/**
 * Registers helmet with the same options app.js uses and returns the response
 * headers for a trivial route, so these assertions cover real helmet output
 * rather than the shape of the options object.
 */
async function headersFor(https) {
  const app = Fastify();
  await app.register(await import("@fastify/helmet"), buildHelmetOptions(https));
  app.get("/", async () => ({ ok: true }));
  const res = await app.inject({ method: "GET", url: "/" });
  await app.close();
  return res.headers;
}

describe("isHttpsDeployment", () => {
  it("detects https site addresses", () => {
    expect(isHttpsDeployment("https://zander.example")).toBe(true);
    expect(isHttpsDeployment("  HTTPS://Zander.Example/  ")).toBe(true);
  });

  it("treats http and unset addresses as non-TLS", () => {
    expect(isHttpsDeployment("http://localhost:8080")).toBe(false);
    expect(isHttpsDeployment("")).toBe(false);
    expect(isHttpsDeployment(undefined)).toBe(false);
  });

  it("does not match a host that merely contains https", () => {
    expect(isHttpsDeployment("http://https.example.com")).toBe(false);
  });
});

describe("session cookie options", () => {
  it("marks the cookie Secure on an https deployment", () => {
    expect(buildSessionCookieOptions(true).secure).toBe(true);
  });

  it("leaves it insecure for local http development so login still works", () => {
    expect(buildSessionCookieOptions(false).secure).toBe(false);
  });

  it("always sets httpOnly and sameSite", () => {
    for (const https of [true, false]) {
      const cookie = buildSessionCookieOptions(https);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("lax");
    }
  });
});

describe("security headers", () => {
  it("sets the baseline hardening headers", async () => {
    const headers = await headersFor(true);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBeDefined();
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sends HSTS on an https deployment", async () => {
    const headers = await headersFor(true);
    expect(headers["strict-transport-security"]).toContain("max-age=15552000");
    expect(headers["strict-transport-security"]).toContain("includeSubDomains");
  });

  it("omits HSTS when not served over TLS", async () => {
    const headers = await headersFor(false);
    expect(headers["strict-transport-security"]).toBeUndefined();
  });

  it("does not emit a CSP, which would blank the inline-script views", async () => {
    // Deliberate: see lib/securityConfig.js. This test exists so enabling CSP
    // is a conscious change with the inline-script work done alongside it.
    const headers = await headersFor(true);
    expect(headers["content-security-policy"]).toBeUndefined();
  });

  it("allows cross-origin resource loading for avatars and assets", async () => {
    const headers = await headersFor(true);
    expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(headers["cross-origin-embedder-policy"]).toBeUndefined();
  });
});
