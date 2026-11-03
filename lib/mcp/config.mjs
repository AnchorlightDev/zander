/**
 * lib/mcp/config.mjs
 *
 * Shared constants for Zander's MCP server (routes/mcpRoutes.js): the resource
 * URL Claude connects to, the OAuth client Claude signs in with, and the one
 * scope an MCP access token carries.
 *
 * Imports nothing app-specific, so it is unit-testable and safe for both the
 * OIDC provider and the MCP route to load.
 */

/** The single OAuth scope an MCP access token is issued for. */
export const MCP_SCOPE = "zander:mcp";

/** Permission node a staff member needs before Claude can act for them. */
export const MCP_PERMISSION_NODE = "zander.web.mcp";

/** Path the MCP endpoint is served on. */
export const MCP_PATH = "/mcp";

function siteBase() {
  return (process.env.siteAddress || "http://localhost:8080").replace(/\/+$/, "");
}

/**
 * Canonical resource identifier (RFC 8707) for the MCP endpoint. This is the
 * URL entered in Claude's connector settings and the `aud` of every MCP token.
 */
export function mcpResourceUrl() {
  return `${siteBase()}${MCP_PATH}`;
}

/** URL of the RFC 9728 protected-resource metadata document for /mcp. */
export function protectedResourceMetadataUrl() {
  return `${siteBase()}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** True if `value` names the MCP resource (tolerates a trailing slash). */
export function isMcpResource(value) {
  if (typeof value !== "string" || !value) return false;
  return value.replace(/\/+$/, "") === mcpResourceUrl();
}

/** OAuth client id Claude uses (pre-registered; see lib/oidc/clientStore.mjs). */
export function mcpClientId() {
  return process.env.OIDC_MCP_CLIENT_ID || "claude";
}

/** Redirect URIs Claude's connector uses for the OAuth callback. */
export const DEFAULT_MCP_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];
