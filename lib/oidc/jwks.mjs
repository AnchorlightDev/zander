/**
 * lib/oidc/jwks.mjs
 *
 * Supplies the signing keys (JWKS, private) oidc-provider uses to sign ID tokens
 * and the JWKS it publishes.
 *
 * Production: set `OIDC_JWKS` to a JSON JWKS containing at least one private RSA
 * or EC key (generate with `node scripts/generate-oidc-jwks.mjs`). Keeping it in
 * env means the keys survive restarts, so issued refresh/ID tokens stay valid.
 *
 * Dev fallback: if `OIDC_JWKS` is unset, an ephemeral RS256 key is generated at
 * boot and a loud warning is printed. That key changes every restart — fine for
 * local testing, never for production (every restart invalidates live tokens).
 */

import { generateKeyPair, exportJWK } from "jose";

let cached = null;

export async function loadJwks() {
  if (cached) return cached;

  const fromEnv = process.env.OIDC_JWKS;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv);
      const keys = Array.isArray(parsed) ? parsed : parsed.keys;
      if (!Array.isArray(keys) || !keys.length) throw new Error("no keys");
      cached = { keys };
      return cached;
    } catch (err) {
      throw new Error(`[OIDC] OIDC_JWKS is set but not a valid JWKS JSON: ${err.message}`);
    }
  }

  console.warn(
    "[OIDC] OIDC_JWKS is not set — generating an EPHEMERAL signing key for this " +
      "process only. Tokens will be invalidated on every restart. Set OIDC_JWKS " +
      "in production (see scripts/generate-oidc-jwks.mjs)."
  );
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.use = "sig";
  jwk.alg = "RS256";
  cached = { keys: [jwk] };
  return cached;
}
