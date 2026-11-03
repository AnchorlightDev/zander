import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  PRINCIPAL_HEADER,
  callApi,
  issueTicket,
  mcpPrincipalHook,
  redeemTicket,
} from "../../lib/mcp/principal.mjs";

describe("principal tickets", () => {
  it("are single use", () => {
    const user = { userId: 1 };
    const ticket = issueTicket(user);
    expect(redeemTicket(ticket)).toBe(user);
    expect(redeemTicket(ticket)).toBeUndefined();
    expect(redeemTicket("made-up")).toBeUndefined();
    expect(redeemTicket(undefined)).toBeUndefined();
  });
});

async function buildApp() {
  const app = Fastify({ logger: false });
  // Stand-in for @fastify/session: every request starts with an empty session.
  app.addHook("onRequest", async (req) => {
    req.session = { sessionId: "anon" };
  });
  await app.register(async (api) => {
    api.addHook("preValidation", mcpPrincipalHook);
    api.post("/api/whoami", async (req) => ({
      success: true,
      user: req.session?.user?.username ?? null,
      sawHeader: PRINCIPAL_HEADER in req.headers,
      body: req.body,
    }));
  });
  await app.ready();
  return app;
}

describe("mcpPrincipalHook + callApi", () => {
  it("runs the route as the given user", async () => {
    const app = await buildApp();
    const { status, data } = await callApi(app, {
      method: "POST",
      url: "/api/whoami",
      body: { a: 1 },
      user: { username: "Ben" },
    });
    expect(status).toBe(200);
    expect(data).toEqual({ success: true, user: "Ben", sawHeader: false, body: { a: 1 } });
  });

  it("ignores a forged or replayed ticket", async () => {
    const app = await buildApp();
    const forged = await app.inject({
      method: "POST",
      url: "/api/whoami",
      headers: { [PRINCIPAL_HEADER]: "guess", "content-type": "application/json" },
      payload: "{}",
    });
    expect(forged.json().user).toBeNull();

    const ticket = issueTicket({ username: "Ben" });
    const first = await app.inject({ method: "POST", url: "/api/whoami", headers: { [PRINCIPAL_HEADER]: ticket } });
    const replay = await app.inject({ method: "POST", url: "/api/whoami", headers: { [PRINCIPAL_HEADER]: ticket } });
    expect(first.json().user).toBe("Ben");
    expect(replay.json().user).toBeNull();
  });

  it("leaves normal requests alone", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/whoami" });
    expect(res.json().user).toBeNull();
  });
});
