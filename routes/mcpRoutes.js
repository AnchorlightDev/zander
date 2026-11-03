/**
 * routes/mcpRoutes.js
 *
 * Zander's MCP server: lets a staff member connect Claude (as a custom
 * connector) and manage events, ranks, announcements, reports and support
 * tickets in conversation. Off unless the `mcp` module is switched on.
 *
 *   POST /mcp                                         JSON-RPC (Streamable HTTP, JSON responses)
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata: where to sign in
 *   GET  /.well-known/oauth-authorization-server[/oidc]
 *   GET  /.well-known/openid-configuration/oidc       the OIDC provider's metadata, at the
 *                                                     paths MCP clients look for it
 *
 * Sign-in is Zander's own OIDC provider (controllers/oidcController.js): Claude
 * gets a short-lived token bound to /mcp for the staff member who signed in,
 * and every tool runs with that person's permissions (lib/mcp/tools).
 */

import { createRequire } from "module";
import { getOidcProvider, getIssuer } from "../controllers/oidcController.js";
import { checkRateLimit } from "../lib/rateLimiter.mjs";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { authenticateMcpRequest } from "../lib/mcp/auth.mjs";
import { loadMcpUser } from "../lib/mcp/userContext.mjs";
import { ERROR, createMcpHandler } from "../lib/mcp/protocol.mjs";
import { visibleTools } from "../lib/mcp/tools/index.mjs";
import {
  MCP_PATH,
  MCP_PERMISSION_NODE,
  MCP_SCOPE,
  mcpResourceUrl,
  protectedResourceMetadataUrl,
} from "../lib/mcp/config.mjs";

const require = createRequire(import.meta.url);
const packageData = require("../package.json");

const INSTRUCTIONS = [
  "These tools act on the CFC (Crafting For Christ) community's Zander platform as the signed-in staff member,",
  "with exactly their website permissions. Times are ISO 8601; always include an offset and the event's IANA time zone.",
  "New events start as drafts and only go public when a reviewer approves or publishes them.",
  "Before anything players will see or that changes someone's access (publishing or cancelling events,",
  "assigning or removing ranks, creating announcements, replying to tickets), confirm the details with the user.",
].join(" ");

export default function mcpRoutes(app, root, features) {
  const isOn = () => features.mcp === true;

  const handler = createMcpHandler({
    serverInfo: { name: "zander", title: "Zander", version: packageData.version || "0.0.0" },
    instructions: INSTRUCTIONS,
    listTools: (ctx) => visibleTools(ctx),
    onToolError: (name, error) => console.error(`[MCP] tool ${name} failed:`, error),
  });

  // ── Discovery ──────────────────────────────────────────────────────────────

  const protectedResource = async (req, res) => {
    if (!isOn()) return res.callNotFound();
    return res.header("cache-control", "public, max-age=300").send({
      resource: mcpResourceUrl(),
      authorization_servers: [getIssuer()],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Zander",
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResource);

  // MCP clients look for the authorization server's metadata at the RFC 8414
  // path-insertion URLs; the provider itself only serves it under /oidc.
  const authServerMetadata = async (req, res) => {
    if (!isOn()) return res.callNotFound();
    // oidc-provider builds every endpoint URL from the request's host and
    // scheme (it trusts X-Forwarded-*), so pass the caller's through --
    // otherwise the document advertises http://localhost/oidc/... endpoints.
    const forwardedHost = req.headers["x-forwarded-host"] || req.headers.host;
    const discovery = await root.inject({
      method: "GET",
      url: "/oidc/.well-known/openid-configuration",
      headers: {
        host: req.headers.host,
        ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
        "x-forwarded-proto": req.headers["x-forwarded-proto"] || req.protocol,
      },
    });
    if (discovery.statusCode !== 200) {
      return res.status(502).send({ error: "server_error", error_description: "OIDC discovery unavailable" });
    }
    return res
      .header("content-type", "application/json; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(discovery.body);
  };
  app.get("/.well-known/oauth-authorization-server", authServerMetadata);
  app.get("/.well-known/oauth-authorization-server/oidc", authServerMetadata);
  app.get("/.well-known/openid-configuration/oidc", authServerMetadata);

  // ── MCP endpoint ─────────────────────────────────────────────────────────

  const unauthorized = (res, description) =>
    res
      .status(401)
      .header(
        "www-authenticate",
        `Bearer resource_metadata="${protectedResourceMetadataUrl()}", error="invalid_token", error_description="${description}"`
      )
      .send({ jsonrpc: "2.0", id: null, error: { code: ERROR.INVALID_REQUEST, message: description } });

  app.post(MCP_PATH, async (req, res) => {
    if (!isOn()) return res.callNotFound();
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 120 })) return res;

    const provider = await getOidcProvider();
    const auth = await authenticateMcpRequest(provider, req.headers.authorization);
    if (!auth.ok) return unauthorized(res, "Sign in to Zander to use this connector.");

    const user = await loadMcpUser(auth.userId);
    if (!user) return unauthorized(res, "This CFC account is unavailable.");

    const message = req.body;
    const id = message && typeof message === "object" && !Array.isArray(message) ? message.id ?? null : null;

    if (!hasPermission(user.permissions || [], MCP_PERMISSION_NODE)) {
      return res.status(403).send({
        jsonrpc: "2.0",
        id,
        error: { code: ERROR.INVALID_REQUEST, message: `Your rank doesn't include ${MCP_PERMISSION_NODE}.` },
      });
    }

    if (Array.isArray(message)) {
      return res.status(400).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: ERROR.INVALID_REQUEST, message: "Send one JSON-RPC message per request." },
      });
    }

    if (message?.method === "tools/call") {
      console.info(`[MCP] ${user.username} (#${user.userId}) called ${message.params?.name}`);
    }

    const reply = await handler(message, { app: root, user, features });
    if (reply === null) return res.status(202).send();
    return res.header("content-type", "application/json; charset=utf-8").send(reply);
  });

  // No server-to-client stream and no sessions to end: POST only.
  const methodNotAllowed = async (req, res) => {
    if (!isOn()) return res.callNotFound();
    return res.status(405).header("allow", "POST").send({ error: "Use POST for MCP requests." });
  };
  app.get(MCP_PATH, methodNotAllowed);
  app.delete(MCP_PATH, methodNotAllowed);
}
