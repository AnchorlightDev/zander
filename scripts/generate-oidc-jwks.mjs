/**
 * scripts/generate-oidc-jwks.mjs
 *
 * Generates a signing key for the Compass OIDC provider and prints a JWKS JSON
 * suitable for the OIDC_JWKS env var. Run once per environment and store the
 * output as a secret:
 *
 *   node scripts/generate-oidc-jwks.mjs
 *
 * Keep the key stable across restarts in production — rotating it invalidates
 * every live ID/refresh token.
 */

import { generateKeyPair, exportJWK } from "jose";

const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.use = "sig";
jwk.alg = "RS256";

const jwks = { keys: [jwk] };
process.stdout.write(`OIDC_JWKS=${JSON.stringify(jwks)}\n`);
