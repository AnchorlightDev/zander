import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import {
  registerCspReportParser,
  normaliseCspReports,
} from "../../lib/csp.js";

/**
 * The browser posts CSP violations with content types Fastify's built-in JSON
 * parser does not claim, so the endpoint answered every report with 415 and
 * the report-only policy collected nothing.  These tests drive the real
 * parser registration through a live Fastify instance rather than asserting
 * against a copy of the logic.
 */
describe("/api/csp-report content types", () => {
  let app;
  const seen = [];

  beforeAll(async () => {
    app = Fastify();
    registerCspReportParser(app);
    app.post("/api/csp-report", async (req, res) => {
      seen.push(...normaliseCspReports(req.body));
      return res.status(204).send();
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts the CSP Level 2 content type browsers actually send", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/csp-report",
      headers: { "content-type": "application/csp-report" },
      payload: JSON.stringify({
        "csp-report": {
          "violated-directive": "img-src",
          "blocked-uri": "https://gravatar.com/avatar/abc",
          "document-uri": "https://example.test/dashboard/events/edit",
        },
      }),
    });

    expect(res.statusCode).toBe(204);
  });

  it("accepts the Reporting API content type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/csp-report",
      headers: { "content-type": "application/reports+json" },
      payload: JSON.stringify([
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "img-src",
            blockedURL: "https://res.cloudinary.com/x/banner.png",
            documentURL: "https://example.test/play",
          },
        },
      ]),
    });

    expect(res.statusCode).toBe(204);
  });

  it("drops a malformed report quietly instead of returning 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/csp-report",
      headers: { "content-type": "application/csp-report" },
      payload: "not json at all",
    });

    expect(res.statusCode).toBe(204);
  });

  it("accepts an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/csp-report",
      headers: { "content-type": "application/csp-report" },
      payload: "",
    });

    expect(res.statusCode).toBe(204);
  });

  it("logged both well-formed reports it was sent", () => {
    // Only the two valid posts above should have produced entries.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      directive: "img-src",
      blocked: "https://gravatar.com/avatar/abc",
      document: "https://example.test/dashboard/events/edit",
    });
    expect(seen[1]).toEqual({
      directive: "img-src",
      blocked: "https://res.cloudinary.com/x/banner.png",
      document: "https://example.test/play",
    });
  });
});

describe("normaliseCspReports", () => {
  it("reads the CSP Level 2 shape", () => {
    const out = normaliseCspReports({
      "csp-report": {
        "violated-directive": "script-src",
        "blocked-uri": "https://evil.test/x.js",
        "document-uri": "https://example.test/",
      },
    });
    expect(out).toEqual([
      { directive: "script-src", blocked: "https://evil.test/x.js", document: "https://example.test/" },
    ]);
  });

  it("reads a batch from the Reporting API", () => {
    const out = normaliseCspReports([
      { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "a" } },
      { type: "csp-violation", body: { effectiveDirective: "font-src", blockedURL: "b" } },
    ]);
    expect(out.map((r) => r.directive)).toEqual(["img-src", "font-src"]);
  });

  it("reads a bare object with no envelope", () => {
    const out = normaliseCspReports({ effectiveDirective: "frame-src", blockedURL: "x" });
    expect(out).toHaveLength(1);
    expect(out[0].directive).toBe("frame-src");
  });

  it("skips entries with no directive, which are nothing to act on", () => {
    expect(normaliseCspReports({})).toEqual([]);
    expect(normaliseCspReports({ "csp-report": {} })).toEqual([]);
    expect(normaliseCspReports([{ body: {} }, null, "junk"])).toEqual([]);
  });

  it("survives null and undefined", () => {
    expect(normaliseCspReports(null)).toEqual([]);
    expect(normaliseCspReports(undefined)).toEqual([]);
  });

  it("reports missing optional fields as null rather than undefined", () => {
    const [report] = normaliseCspReports({ effectiveDirective: "img-src" });
    expect(report.blocked).toBeNull();
    expect(report.document).toBeNull();
  });
});
