/**
 * End-to-end sign-in for the Claude connector against a real oidc-provider,
 * configured with the same resource-indicator, refresh-token and grant rules
 * Zander uses (lib/mcp/oidcConfig.mjs), on the in-memory adapter.
 *
 * Covers: an authorization-code + PKCE flow carrying `resource`, an opaque
 * access token bound to /mcp that lib/mcp/auth.mjs accepts, a refresh token
 * despite no prompt=consent, and that the token is useless to other clients.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import crypto from "crypto";
import Provider from "oidc-provider";

let server;
let base;
let provider;
let saved;
let oidcConfig;
let auth;

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

beforeAll(async () => {
  saved = { siteAddress: process.env.siteAddress, id: process.env.OIDC_MCP_CLIENT_ID };
  delete process.env.OIDC_MCP_CLIENT_ID;

  server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.siteAddress = base;

  oidcConfig = await import("../../lib/mcp/oidcConfig.mjs");
  auth = await import("../../lib/mcp/auth.mjs");

  provider = new Provider(base, {
    clients: [
      {
        client_id: "claude",
        token_endpoint_auth_method: "none",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid offline_access",
      },
      {
        client_id: "compass",
        client_secret: "s3cret",
        redirect_uris: ["https://compass.example.com/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    ],
    findAccount: async (ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    scopes: ["openid", "profile", "groups", "offline_access"],
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: oidcConfig.resourceIndicators,
    },
    issueRefreshToken: oidcConfig.issueRefreshToken,
    pkce: { required: () => true },
    interactions: { url: (ctx, interaction) => `/interaction/${interaction.uid}` },
  });

  const callback = provider.callback();
  server.on("request", async (req, res) => {
    if (req.url.startsWith("/interaction/")) {
      // Stand-in for routes/oidcRoutes.js: user 42 is signed in and staff.
      const { params } = await provider.interactionDetails(req, res);
      const grant = new provider.Grant({ accountId: "42", clientId: params.client_id });
      oidcConfig.applyGrantScopes(grant, params);
      const grantId = await grant.save();
      await provider.interactionFinished(
        req,
        res,
        { login: { accountId: "42" }, consent: { grantId } },
        { mergeWithLastSubmission: false }
      );
      return;
    }
    callback(req, res);
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.env.siteAddress = saved.siteAddress;
  if (saved.id !== undefined) process.env.OIDC_MCP_CLIENT_ID = saved.id;
});

/** Follow redirects by hand, carrying cookies, until we land on `stopAt`. */
async function follow(url, stopAt) {
  const jar = new Map();
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair.split("=");
      jar.set(name.trim(), value.join("="));
    }
    const location = res.headers.get("location");
    if (!location) throw new Error(`Stopped at ${url} with ${res.status}: ${await res.text()}`);
    const next = new URL(location, url).toString();
    if (next.startsWith(stopAt)) return new URL(next);
    url = next;
  }
  throw new Error("Too many redirects");
}

async function token(body) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("Claude connector sign-in", () => {
  let tokens;

  it("issues an /mcp-bound access token and a refresh token", async () => {
    const authorize = new URL(`${base}/auth`);
    authorize.search = new URLSearchParams({
      client_id: "claude",
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "zander:mcp",
      resource: `${base}/mcp`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
    });

    const landed = await follow(authorize.toString(), REDIRECT);
    expect(landed.searchParams.get("state")).toBe("xyz");
    const code = landed.searchParams.get("code");
    expect(code).toBeTruthy();

    const res = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: "claude",
      code_verifier: verifier,
      resource: `${base}/mcp`,
    });
    expect(res.status).toBe(200);
    expect(res.json.scope).toBe("zander:mcp");
    expect(res.json.refresh_token).toBeTruthy();
    tokens = res.json;
  });

  it("is accepted by the MCP bearer check as user 42", async () => {
    const result = await auth.authenticateMcpRequest(provider, `Bearer ${tokens.access_token}`);
    expect(result).toEqual({ ok: true, userId: 42 });
  });

  it("refreshes into another valid MCP token", async () => {
    const res = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "claude" });
    expect(res.status).toBe(200);
    const result = await auth.authenticateMcpRequest(provider, `Bearer ${res.json.access_token}`);
    expect(result.ok).toBe(true);
  });

  it("defaults the resource when Claude doesn't send one", async () => {
    const authorize = new URL(`${base}/auth`);
    authorize.search = new URLSearchParams({
      client_id: "claude",
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "zander:mcp offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const code = (await follow(authorize.toString(), REDIRECT)).searchParams.get("code");
    const res = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: "claude",
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect((await auth.authenticateMcpRequest(provider, `Bearer ${res.json.access_token}`)).ok).toBe(true);
  });

  it("rejects made-up tokens", async () => {
    expect((await auth.authenticateMcpRequest(provider, "Bearer not-a-token")).ok).toBe(false);
    expect((await auth.authenticateMcpRequest(provider, undefined)).ok).toBe(false);
  });

  it("won't issue an /mcp token to another client", async () => {
    const authorize = new URL(`${base}/auth`);
    authorize.search = new URLSearchParams({
      client_id: "compass",
      response_type: "code",
      redirect_uri: "https://compass.example.com/cb",
      scope: "openid",
      resource: `${base}/mcp`,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const landed = await follow(authorize.toString(), "https://compass.example.com/cb");
    expect(landed.searchParams.get("error")).toBe("invalid_target");
  });
});
