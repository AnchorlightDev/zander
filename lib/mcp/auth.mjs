/**
 * lib/mcp/auth.mjs
 *
 * Bearer-token check for the MCP endpoint. Tokens are opaque oidc-provider
 * access tokens (controllers/oidcController.js), so they are looked up in the
 * provider's own store rather than verified as JWTs. A token is accepted only
 * if it is unexpired, was issued to the MCP client, carries the zander:mcp
 * scope and names this server's /mcp URL as its audience.
 */

import { MCP_SCOPE, isMcpResource, mcpClientId } from "./config.mjs";

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function readBearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Decide whether a looked-up access token may be used on /mcp.
 * Pure, so it is unit-tested without a provider.
 *
 * @returns {{ ok: true, userId: number } | { ok: false, reason: string }}
 */
export function checkAccessToken(token, { now = Date.now() } = {}) {
  if (!token) return { ok: false, reason: "unknown token" };
  if (typeof token.isExpired === "boolean" ? token.isExpired : token.exp * 1000 <= now) {
    return { ok: false, reason: "expired token" };
  }
  if (token.clientId !== mcpClientId()) return { ok: false, reason: "token not issued to the MCP client" };

  const audiences = [].concat(token.aud || []);
  if (!audiences.some((aud) => isMcpResource(aud))) return { ok: false, reason: "token audience is not this server" };

  const scopes = String(token.scope || "").split(/\s+/);
  if (!scopes.includes(MCP_SCOPE)) return { ok: false, reason: "token lacks the zander:mcp scope" };

  const userId = Number(token.accountId);
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, reason: "token has no account" };

  return { ok: true, userId };
}

/**
 * Resolve the bearer token on a request to a CFC user id.
 *
 * @param {import("oidc-provider").default} provider
 */
export async function authenticateMcpRequest(provider, authorizationHeader) {
  const raw = readBearer(authorizationHeader);
  if (!raw) return { ok: false, reason: "missing bearer token" };

  let token;
  try {
    token = await provider.AccessToken.find(raw);
  } catch {
    token = null;
  }
  return checkAccessToken(token);
}
