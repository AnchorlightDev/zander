/**
 * lib/oidc/clientStore.mjs
 *
 * The OAuth/OIDC client registry (oauthClients table, migration 0072).
 *
 * - `seedCompassClient()` upserts the first-party `compass` client from env on
 *   boot, so redirect URIs and the client secret come from configuration, never
 *   hard-coded. Called once from controllers/oidcController.js.
 * - `listClients()` returns active clients in the shape oidc-provider expects
 *   (snake_case metadata), consumed by the Prisma adapter's Client.find.
 *
 * Secrets: the client secret is a shared secret for a confidential, first-party
 * app we control, stored in the clear in our own DB (same trust level as the
 * app's other env-held secrets). It is never logged or returned to browsers.
 */

import { prisma } from "../../controllers/databaseController.js";
import { DEFAULT_MCP_REDIRECT_URIS, mcpClientId } from "../mcp/config.mjs";

function parseList(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toJson(arr) {
  return JSON.stringify(arr || []);
}

/**
 * Upsert the Compass first-party client from env. Idempotent — safe to run on
 * every boot. Does nothing (and warns) if no redirect URIs are configured, so a
 * misconfigured deploy fails loudly rather than registering a useless client.
 */
export async function seedCompassClient() {
  const clientKey = process.env.OIDC_COMPASS_CLIENT_ID || "compass";
  const redirectUris = parseList(process.env.OIDC_COMPASS_REDIRECT_URIS);
  const postLogout = parseList(process.env.OIDC_COMPASS_POST_LOGOUT_URIS);
  const secret = process.env.OIDC_COMPASS_CLIENT_SECRET || null;

  if (!redirectUris.length) {
    console.warn(
      "[OIDC] OIDC_COMPASS_REDIRECT_URIS is empty — the Compass client was not seeded. " +
        "Set it (comma-separated) to enable Compass sign-in."
    );
    return;
  }
  if (!secret) {
    console.warn("[OIDC] OIDC_COMPASS_CLIENT_SECRET is empty — the Compass client cannot authenticate.");
  }

  const data = {
    name: "Compass staff portal",
    clientSecret: secret,
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: toJson(redirectUris),
    postLogoutRedirectUris: toJson(postLogout),
    grantTypes: toJson(["authorization_code", "refresh_token"]),
    responseTypes: toJson(["code"]),
    scopes: "openid profile groups offline_access",
    firstParty: true,
    isActive: true,
  };

  await prisma.oauthClients.upsert({
    where: { clientKey },
    create: { clientKey, ...data },
    update: data,
  });

  console.log(`[OIDC] Compass client "${clientKey}" registered (${redirectUris.length} redirect URI(s)).`);
}

/**
 * Upsert the client Claude's custom connector signs in with (the Zander MCP
 * server, routes/mcpRoutes.js). Idempotent, runs on every boot.
 *
 * Off unless OIDC_MCP_ENABLED is "true", so an install that never uses the MCP
 * server never has a client registered for it; turning it back off marks the
 * client inactive so no new sign-ins succeed.
 *
 * With OIDC_MCP_CLIENT_SECRET set it is a confidential client (enter the ID and
 * secret under the connector's advanced settings); without one it is a public
 * client that relies on PKCE alone.
 */
export async function seedMcpClient() {
  const clientKey = mcpClientId();
  const enabled = String(process.env.OIDC_MCP_ENABLED || "").toLowerCase() === "true";

  if (!enabled) {
    await prisma.oauthClients.updateMany({ where: { clientKey }, data: { isActive: false } });
    return;
  }

  const redirectUris = parseList(process.env.OIDC_MCP_REDIRECT_URIS, DEFAULT_MCP_REDIRECT_URIS);
  const secret = process.env.OIDC_MCP_CLIENT_SECRET || null;

  const data = {
    name: "Claude (Zander MCP)",
    clientSecret: secret,
    // How Claude presents the secret at the token endpoint. client_secret_basic
    // is the OAuth default; switch to client_secret_post if sign-in fails with
    // invalid_client at the token step.
    tokenEndpointAuthMethod: process.env.OIDC_MCP_TOKEN_AUTH_METHOD || "client_secret_basic",
    redirectUris: toJson(redirectUris),
    postLogoutRedirectUris: toJson([]),
    grantTypes: toJson(["authorization_code", "refresh_token"]),
    responseTypes: toJson(["code"]),
    // OIDC scopes only: zander:mcp is a resource scope, granted per resource
    // (lib/mcp/oidcConfig.mjs). Listing it here makes the client invalid.
    scopes: "openid offline_access",
    // Consent is skipped like Compass: the only thing this client can obtain
    // is an MCP token, and every tool re-checks the user's own permissions.
    firstParty: true,
    isActive: true,
  };

  await prisma.oauthClients.upsert({
    where: { clientKey },
    create: { clientKey, ...data },
    update: data,
  });

  console.log(
    `[OIDC] MCP client "${clientKey}" registered (${secret ? "confidential" : "public, PKCE only"}, ${redirectUris.length} redirect URI(s)).`
  );
}

/** Active clients in oidc-provider ClientMetadata shape. */
export async function listClients() {
  const rows = await prisma.oauthClients.findMany({ where: { isActive: true } });
  return rows.map(toClientMetadata);
}

function toClientMetadata(row) {
  const parse = (v, fallback) => {
    try {
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    client_id: row.clientKey,
    client_name: row.name,
    client_secret: row.clientSecret || undefined,
    token_endpoint_auth_method: row.clientSecret
      ? row.tokenEndpointAuthMethod
      : "none",
    redirect_uris: parse(row.redirectUris, []),
    post_logout_redirect_uris: parse(row.postLogoutRedirectUris, []),
    grant_types: parse(row.grantTypes, ["authorization_code"]),
    response_types: parse(row.responseTypes, ["code"]),
    scope: row.scopes || "openid",
    // Marks a client whose consent we skip. oidc-provider reads unknown metadata
    // off the client object, so our interaction handler can check it.
    firstParty: !!row.firstParty,
  };
}

/** True if the named client is first-party (consent skipped). */
export async function isFirstPartyClient(clientKey) {
  const row = await prisma.oauthClients.findUnique({ where: { clientKey } });
  return !!(row && row.isActive && row.firstParty);
}
