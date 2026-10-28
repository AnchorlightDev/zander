/**
 * admin/credential-vault.mjs — server-console tasks for the Credential Vault.
 *
 *   node admin/credential-vault.mjs keygen [id]
 *       Print a new random key-encryption key line for CREDENTIAL_VAULT_KEKS.
 *       Nothing is written anywhere; copy it into the host's environment and
 *       into the offline escrow.
 *
 *   node admin/credential-vault.mjs bootstrap <username>
 *       Give the first vault administrator manage_vault (+ manage_collections,
 *       view_audit, approve_requests, create). Grants no reveal/copy.
 *
 *   node admin/credential-vault.mjs rewrap
 *       After adding a new KEK and making it CREDENTIAL_VAULT_ACTIVE_KEK,
 *       re-wrap every data key under it. Then verify and retire the old key.
 *
 *   node admin/credential-vault.mjs verify-audit
 *       Check the audit hash chain end to end.
 *
 *   node admin/credential-vault.mjs status
 *       Show whether keys are loaded (ids only, never key material).
 *
 * Every task here needs shell access to the server, which is the trust
 * boundary for the KEK anyway.
 */

import dotenv from "dotenv";

dotenv.config();

const [command, arg] = process.argv.slice(2);

async function main() {
  if (command === "keygen") {
    const { generateKek } = await import("../lib/credentialVault/crypto.mjs");
    const id = arg && /^[A-Za-z0-9_-]{1,32}$/.test(arg) ? arg : `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    console.log(`${id}:${generateKek()}`);
    console.error(
      `\nAppend this to CREDENTIAL_VAULT_KEKS (comma-separated) and, for a new vault, set CREDENTIAL_VAULT_ACTIVE_KEK=${id}.\n` +
        "Store a copy in the offline escrow. Losing every copy of a key loses every secret wrapped with it."
    );
    return;
  }

  const { keyProviderFromEnv } = await import("../lib/credentialVault/crypto.mjs");
  if (command === "status") {
    const { provider, error } = keyProviderFromEnv();
    console.log(provider ? provider.describe() : { configured: false, error });
    return;
  }

  const svc = await import("../services/credentialVaultService.js");

  if (command === "bootstrap") {
    if (!arg) throw new Error("Usage: node admin/credential-vault.mjs bootstrap <username>");
    const result = await svc.bootstrapAdministrator(arg);
    console.log(`Granted vault administration to ${arg} (user ${result.userId}, grant ${result.grantId}).`);
    console.log("They still have no reveal or copy access; grant that explicitly in the vault.");
    return;
  }

  if (command === "rewrap") {
    const result = await svc.rewrapAllKeys();
    console.log(`Re-wrapped ${result.rewrapped} data key(s) under ${result.activeKekId}.` + (result.fingerprintRewrapped ? " Fingerprint key re-wrapped." : ""));
    return;
  }

  if (command === "verify-audit") {
    const result = await svc.verifyAuditChain({ vaultCaps: new Set(["view_audit"]) });
    console.log(result.ok ? `Audit chain OK (${result.checked} events).` : `Audit chain BROKEN at event ${result.brokenAtEventId} (after ${result.checked} good events).`);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  console.log("Commands: keygen [id] | status | bootstrap <username> | rewrap | verify-audit");
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
