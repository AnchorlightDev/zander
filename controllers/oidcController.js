/**
 * controllers/oidcController.js
 *
 * Builds the oidc-provider instance that turns Zander into an OpenID Connect
 * provider for the Compass staff portal (and any future first-party app).
 *
 * - Clients come from the `oauthClients` registry table via the Prisma adapter
 *   (lib/oidc/clientStore.mjs seeds the Compass client from env on boot).
 * - Accounts + the STAFF GATE + claims live in lib/oidc/accounts.mjs.
 * - Signing keys come from lib/oidc/jwks.mjs (OIDC_JWKS env in production).
 *
 * The provider is created once (memoised). Routes are wired in
 * routes/oidcRoutes.js.
 */

import Provider from "oidc-provider";
import { createAdapter } from "../lib/oidc/prismaAdapter.mjs";
import { loadJwks } from "../lib/oidc/jwks.mjs";
import { findAccount } from "../lib/oidc/accounts.mjs";
import { seedCompassClient } from "../lib/oidc/clientStore.mjs";

const TEN_MINUTES = 10 * 60; // brief: access tokens last 10 minutes
const FOURTEEN_DAYS = 14 * 24 * 60 * 60;

let providerPromise = null;

/** Absolute issuer identifier, e.g. https://zander.example.com/oidc */
export function getIssuer() {
  if (process.env.OIDC_ISSUER) return process.env.OIDC_ISSUER.replace(/\/$/, "");
  const base = (process.env.siteAddress || "http://localhost:8080").replace(/\/$/, "");
  return `${base}/oidc`;
}

export function getOidcProvider() {
  if (!providerPromise) providerPromise = build();
  return providerPromise;
}

async function build() {
  await seedCompassClient();
  const jwks = await loadJwks();

  const provider = new Provider(getIssuer(), {
    adapter: createAdapter,
    jwks,
    findAccount,

    // Clients are not listed statically — the adapter serves them from the
    // oauthClients table (lib/oidc/prismaAdapter.mjs → clientStore.listClients).
    clients: [],

    scopes: ["openid", "profile", "groups", "offline_access"],

    claims: {
      openid: ["sub"],
      // discord_id is only emitted by the account when the user is linked.
      profile: ["preferred_username", "discord_id", "picture"],
      groups: ["groups"],
    },

    // Put profile/groups/discord_id straight in the ID token so Compass does not
    // need a second userinfo round-trip on every login.
    conformIdTokenClaims: false,

    features: {
      devInteractions: { enabled: false }, // we provide our own interaction UI
      rpInitiatedLogout: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
    },

    // PKCE required for every client (brief: Compass logs in with PKCE).
    pkce: { required: () => true },

    // Rotate refresh tokens; the staff gate in findAccount re-checks groups on
    // every refresh and refuses (invalid_grant) once staff access is lost.
    rotateRefreshToken: true,

    ttl: {
      AccessToken: TEN_MINUTES,
      IdToken: TEN_MINUTES,
      AuthorizationCode: 60,
      RefreshToken: FOURTEEN_DAYS,
      Interaction: 60 * 60,
      Session: FOURTEEN_DAYS,
      Grant: FOURTEEN_DAYS,
    },

    cookies: {
      keys: [process.env.sessionCookieSecret].filter(Boolean),
    },

    // Send the browser to our own interaction page (routes/oidcRoutes.js).
    interactions: {
      url(ctx, interaction) {
        return `/oidc/interaction/${interaction.uid}`;
      },
    },
  });

  // Behind a reverse proxy (Render / CDN) — trust X-Forwarded-* for https + host.
  provider.proxy = true;

  return provider;
}
