import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";

const SITE = "https://zander.example.com";

vi.mock("../../controllers/oidcController.js", () => ({
  getIssuer: () => `${SITE}/oidc`,
  getOidcProvider: async () => ({
    AccessToken: {
      find: async (raw) =>
        raw === "good"
          ? { isExpired: false, clientId: "claude", aud: `${SITE}/mcp`, scope: "zander:mcp", accountId: "7" }
          : undefined,
    },
  }),
}));

const users = {
  7: { userId: 7, username: "Ben", permissions: ["zander.web.mcp", "zander.web.events"], ranks: [] },
};
vi.mock("../../lib/mcp/userContext.mjs", () => ({ loadMcpUser: async (id) => users[id] ?? null }));

vi.mock("../../lib/mcp/tools/index.mjs", () => ({
  visibleTools: (ctx) => [
    {
      name: "whoami",
      description: "Who",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, c) => ({ username: c.user.username }),
    },
  ],
}));

const { default: mcpRoutes } = await import("../../routes/mcpRoutes.js");

let saved;
beforeEach(() => {
  saved = process.env.siteAddress;
  process.env.siteAddress = SITE;
  users[7].permissions = ["zander.web.mcp", "zander.web.events"];
});
afterEach(() => {
  process.env.siteAddress = saved;
});

async function build(features = { mcp: true }) {
  const app = Fastify({ logger: false });
  await app.register(async (instance) => mcpRoutes(instance, app, features));
  // Stand-in for the provider's own discovery document.
  // Like oidc-provider, it builds URLs from the forwarded host and scheme.
  app.get("/oidc/.well-known/openid-configuration", async (req) => ({
    issuer: `${SITE}/oidc`,
    authorization_endpoint: `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"]}/oidc/auth`,
  }));
  await app.ready();
  return app;
}

const rpc = (app, body, token = "good") =>
  app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify(body),
  });

describe("/mcp", () => {
  it("does not exist while the module is off", async () => {
    const app = await build({ mcp: false });
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" })).statusCode).toBe(404);
    expect((await app.inject("/.well-known/oauth-protected-resource/mcp")).statusCode).toBe(404);
  });

  it("asks for sign-in, pointing at the resource metadata", async () => {
    const app = await build();
    const res = await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, null);
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(
      `resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`
    );
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, "forged")).statusCode).toBe(401);
  });

  it("publishes protected-resource and authorization-server metadata", async () => {
    const app = await build();
    const prm = (await app.inject("/.well-known/oauth-protected-resource/mcp")).json();
    expect(prm).toMatchObject({
      resource: `${SITE}/mcp`,
      authorization_servers: [`${SITE}/oidc`],
      scopes_supported: ["zander:mcp"],
    });
    const as = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server/oidc",
      headers: { host: "zander.example.com", "x-forwarded-proto": "https" },
    });
    expect(as.json().issuer).toBe(`${SITE}/oidc`);
    expect(as.json().authorization_endpoint).toBe(`${SITE}/oidc/auth`);
  });

  it("speaks MCP to a signed-in staff member", async () => {
    const app = await build();
    const init = (await rpc(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(init.result.serverInfo.name).toBe("zander");

    const note = await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.statusCode).toBe(202);

    const call = (await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } })).json();
    expect(JSON.parse(call.result.content[0].text)).toEqual({ username: "Ben" });
  });

  it("refuses accounts without zander.web.mcp", async () => {
    users[7].permissions = ["zander.web.events"];
    const app = await build();
    const res = await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/zander\.web\.mcp/);
  });

  it("only accepts POST and single messages", async () => {
    const app = await build();
    expect((await app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(405);
    expect((await rpc(app, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).statusCode).toBe(400);
  });
});
