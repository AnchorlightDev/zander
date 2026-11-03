/**
 * routes/oidcRoutes.js
 *
 * Wires the oidc-provider instance into Fastify. Two parts, registered at two
 * different points in app.js because they have opposite needs:
 *
 *  1. mountOidcProvider(instance) — the provider's own endpoints (/oidc/auth,
 *     /oidc/token, /oidc/me, /oidc/jwks, /oidc/.well-known/...). Registered
 *     BEFORE @fastify/formbody so the token endpoint's form body reaches the
 *     library unconsumed. The handler hijacks the reply and hands the raw
 *     req/res to provider.callback(), express-style.
 *
 *  2. registerOidcInteractions(instance) — our interaction page
 *     (/oidc/interaction/:uid). Registered AFTER the session plugin because it
 *     reads req.session.user (the Zander login) to decide who is signing in.
 *     A more-specific param route, so it wins over the /oidc/* wildcard.
 *
 * NOTE (verify on deploy): mounting oidc-provider under a sub-path inside
 * Fastify cannot be exercised in unit tests here (the app needs the external
 * databases to boot). The express-style mount below is the documented pattern;
 * the manual test steps in the Phase 1 summary confirm discovery, token and
 * interaction cookies end to end.
 */

import { getOidcProvider } from "../controllers/oidcController.js";
import { resolveStaffStatus } from "../lib/oidc/accounts.mjs";
import { explainDenial } from "../lib/oidc/denial.mjs";
import { getUserPermissions } from "../controllers/userController.js";
import { hasPermission as holdsNode } from "../lib/discord/permissions.mjs";
import { MCP_PERMISSION_NODE, mcpClientId } from "../lib/mcp/config.mjs";
import { applyGrantScopes } from "../lib/mcp/oidcConfig.mjs";

const MOUNT = "/oidc";

/** Strip the /oidc mount prefix so the provider sees root-relative routes. */
function stripMount(url) {
  const stripped = url.replace(/^\/oidc(?=\/|\?|$)/, "");
  return stripped.length ? stripped : "/";
}

export async function mountOidcProvider(instance) {
  const provider = await getOidcProvider();
  const callback = provider.callback();

  // This encapsulated instance is registered before @fastify/formbody, so no
  // body parser is inherited. Replace parsers with a no-op that leaves the raw
  // stream intact for the provider to read.
  instance.removeAllContentTypeParsers();
  instance.addContentTypeParser("*", (req, payload, done) => done(null));

  const handle = (req, reply) => {
    reply.hijack();
    const raw = req.raw;
    raw.originalUrl = raw.url; // keep the full path for mount-path recovery
    raw.url = stripMount(raw.url);
    callback(raw, reply.raw);
  };

  instance.all(MOUNT, handle);
  instance.all(`${MOUNT}/*`, handle);
}

export function registerOidcInteractions(instance) {
  instance.get("/oidc/interaction/:uid", async (req, reply) => {
    const provider = await getOidcProvider();
    reply.hijack();

    let details;
    try {
      details = await provider.interactionDetails(req.raw, reply.raw);
    } catch {
      reply.raw.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      reply.raw.end(page("Sign-in expired", "This sign-in link has expired. Please start the sign-in again."));
      return;
    }

    const { params, uid } = details;
    const sessionUser = req.session?.user;
    const isMcp = params.client_id === mcpClientId();

    // 1. Not logged in to Zander → send to the normal login, come back here.
    if (!sessionUser?.userId) {
      const returnTo = `/oidc/interaction/${uid}`;
      reply.raw.writeHead(302, { Location: `/login?returnTo=${encodeURIComponent(returnTo)}` });
      reply.raw.end();
      return;
    }

    // 2. Logged in — is this a staff account right now?
    const status = await resolveStaffStatus(sessionUser.userId);
    if (!status.ok) {
      reply.raw.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      const why = explainDenial(status, { product: isMcp ? "Connecting Claude to Zander" : "Compass" });
      reply.raw.end(page("Staff only", why.summary, { reasons: why.reasons, footer: why.footer }));
      return;
    }

    // 2b. Claude (MCP) additionally needs the zander.web.mcp node.
    if (isMcp) {
      const permissions = await getUserPermissions(status.user).catch(() => []);
      if (!holdsNode(permissions, MCP_PERMISSION_NODE)) {
        reply.raw.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        reply.raw.end(
          page(
            "Not enabled for your account",
            `Your rank doesn't include the ${MCP_PERMISSION_NODE} permission, so Claude can't be connected to Zander for you. Ask an admin to grant it.`
          )
        );
        return;
      }
    }

    // 3. First-party client → skip consent: grant the requested scopes outright.
    const accountId = String(status.user.userId);
    const grant = new provider.Grant({ accountId, clientId: params.client_id });
    // OIDC scopes as requested; for Claude, also the zander:mcp scope on /mcp.
    applyGrantScopes(grant, params);
    const grantId = await grant.save();

    await provider.interactionFinished(
      req.raw,
      reply.raw,
      { login: { accountId }, consent: { grantId } },
      { mergeWithLastSubmission: false }
    );
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(title, body, { reasons = [], footer = "" } = {}) {
  const why = reasons.length
    ? `<section class="why"><h2>Why</h2><ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></section>`
    : "";
  const foot = footer ? `<p class="foot">${escapeHtml(footer)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Zander sign-in</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0f1115; color: #e7e9ee; }
  main { max-width: 32rem; padding: 2rem 1rem; text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { opacity: .85; }
  .why { text-align: left; background: #181b22; border: 1px solid #2a2f3a; border-radius: 10px; padding: .75rem 1rem; margin: 1rem 0; }
  .why h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 0 0 .35rem; }
  .why ul { margin: 0; padding-left: 1.1rem; }
  .why li { margin: .25rem 0; overflow-wrap: anywhere; }
  .foot { font-size: .85rem; opacity: .65; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${why}${foot}</main></body></html>`;
}
