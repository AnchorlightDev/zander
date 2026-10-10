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
      reply.raw.end(page("Sign-in expired", "This sign-in link has expired. Please start again from Compass."));
      return;
    }

    const { params, uid } = details;
    const sessionUser = req.session?.user;

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
      reply.raw.end(
        page(
          "Staff only",
          "Compass is for CFC staff only. Your account doesn't currently hold a staff role, so it can't sign in."
        )
      );
      return;
    }

    // 3. First-party client → skip consent: grant the requested scopes outright.
    const accountId = String(status.user.userId);
    const grant = new provider.Grant({ accountId, clientId: params.client_id });
    grant.addOIDCScope(params.scope || "openid");
    const grantId = await grant.save();

    await provider.interactionFinished(
      req.raw,
      reply.raw,
      { login: { accountId }, consent: { grantId } },
      { mergeWithLastSubmission: false }
    );
  });
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Compass</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0f1115; color: #e7e9ee; }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { opacity: .85; }
</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}
