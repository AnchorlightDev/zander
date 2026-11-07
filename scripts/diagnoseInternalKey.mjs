/*
 * Read-only diagnostic for the internal API credential used by the Shop
 * Directory proxy (and other self-calls). Makes NO changes.
 *
 * Run on the server:
 *   node scripts/diagnoseInternalKey.mjs
 *
 * It replicates exactly what api/routes/verifyToken.js does for the
 * INTERNAL_API_KEY against the path /api/shop/get, and reports the first step
 * that would cause a 401/403 — which is what makes the proxy show
 * "Shop service is temporarily unavailable."
 */
import dotenv from "dotenv";
dotenv.config();

import { parseKey, resolveScope, verifyKeyHash } from "../lib/apiKeys.js";
import { getClientByPrefix } from "../controllers/apiClientController.js";

const PATH = "/api/shop/get";

const main = async () => {
  const token = process.env.INTERNAL_API_KEY;
  console.log(`\n=== Internal API key check for ${PATH} ===\n`);

  if (!token) {
    console.log("FAIL: INTERNAL_API_KEY is not set in the environment.");
    return;
  }
  console.log(`INTERNAL_API_KEY present: yes (length ${token.length})`);

  const parsed = parseKey(token);
  if (!parsed) {
    console.log("FAIL: INTERNAL_API_KEY is not a well-formed 'zdr_<prefix>_<secret>' key.");
    console.log("      -> verifyToken rejects it with 401 invalidToken.");
    return;
  }
  console.log(`Key prefix: ${parsed.keyPrefix}`);

  const client = await getClientByPrefix(parsed.keyPrefix);
  if (!client) {
    console.log("FAIL: no apiClients row matches this key prefix (401 invalidToken).");
    return;
  }
  console.log(`Matched client: "${client.name}" (clientId=${client.clientId})`);

  if (!verifyKeyHash(token, client.keyHash)) {
    console.log("FAIL: key hash mismatch (401 invalidToken). The stored key does not match INTERNAL_API_KEY.");
    return;
  }
  console.log("Key hash: matches");

  if (client.isRevoked) {
    console.log("FAIL: this client is REVOKED (401 invalidToken).");
    return;
  }
  console.log("Revoked: no");

  const scope = resolveScope(PATH);
  console.log(`Scope required for ${PATH}: ${scope}`);
  console.log(`Client scopes: ${JSON.stringify(client.scopes)}`);

  if (!scope) {
    console.log("FAIL: no scope mapped for the path (403).");
    return;
  }
  if (!Array.isArray(client.scopes) || !client.scopes.includes(scope)) {
    console.log(`\n>>> FAIL: client is NOT scoped for "${scope}" -> 403.`);
    console.log(`>>> FIX: add the "${scope}" scope to the "${client.name}" client at /dashboard/apikeys.`);
    return;
  }

  console.log(`\n>>> PASS: the internal key is valid and scoped for "${scope}".`);
  console.log(">>> The auth layer is fine; the problem is elsewhere (proxy fetch, feature flag, or enrichment). Check the Render logs while searching.");
};

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => process.exit());
