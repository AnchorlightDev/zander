/**
 * lib/mcp/oidcConfig.mjs
 *
 * The oidc-provider settings that let Claude obtain a token for the MCP
 * endpoint, kept apart from controllers/oidcController.js (which needs the
 * database) so they are tested against a real provider in
 * tests/unit/mcpOidcFlow.test.mjs.
 *
 * Resource Indicators (RFC 8707): only the MCP client may obtain a token for
 * /mcp, and that token is good for nothing else -- its audience is the /mcp
 * URL and its only scope is zander:mcp. Every other client keeps the
 * behaviour it had before (no resource; userinfo-only access tokens).
 */

import { errors } from "oidc-provider";
import { MCP_SCOPE, isMcpResource, mcpClientId, mcpResourceUrl } from "./config.mjs";

const ONE_HOUR = 60 * 60; // MCP access tokens; Claude refreshes them as needed

export function isMcpClient(client) {
  return client?.clientId === mcpClientId();
}

export const resourceIndicators = {
  enabled: true,
  async defaultResource(ctx, client, oneOf) {
    if (oneOf) {
      const mcp = oneOf.find((value) => isMcpResource(value));
      return isMcpClient(client) && mcp ? mcp : oneOf;
    }
    return isMcpClient(client) ? mcpResourceUrl() : undefined;
  },
  async useGrantedResource() {
    return true;
  },
  async getResourceServerInfo(ctx, resourceIndicator, client) {
    if (isMcpClient(client) && isMcpResource(resourceIndicator)) {
      return {
        scope: MCP_SCOPE,
        audience: mcpResourceUrl(),
        accessTokenTTL: ONE_HOUR,
        accessTokenFormat: "opaque",
      };
    }
    throw new errors.InvalidTarget();
  },
};

/**
 * Claude's connector does not send prompt=consent, so oidc-provider would drop
 * offline_access and issue no refresh token -- the connector would then need a
 * fresh sign-in every hour. The MCP client always gets one; the staff gate in
 * findAccount still runs on every refresh.
 */
export async function issueRefreshToken(ctx, client, code) {
  if (!client.grantTypeAllowed("refresh_token")) return false;
  return isMcpClient(client) || code.scopes.has("offline_access");
}

/** Scopes the provider itself understands (resource scopes are granted separately). */
const OIDC_SCOPES = new Set(["openid", "profile", "groups", "offline_access"]);

/**
 * Fill a consent-skipping Grant for an authorization request: the requested
 * OIDC scopes, plus -- for the MCP client -- the zander:mcp scope on the /mcp
 * resource Claude asked for (or the default one).
 */
export function applyGrantScopes(grant, params) {
  const requested = String(params.scope || "openid").split(/\s+/).filter(Boolean);
  const oidcScopes = requested.filter((scope) => OIDC_SCOPES.has(scope));
  if (oidcScopes.length) grant.addOIDCScope(oidcScopes.join(" "));

  if (params.client_id === mcpClientId()) {
    const asked = [].concat(params.resource || []).find((value) => isMcpResource(value));
    grant.addResourceScope(asked || mcpResourceUrl(), MCP_SCOPE);
  }
  return grant;
}
