/**
 * cron/credentialVaultCron.js
 *
 * Credential Vault housekeeping: marks expired temporary access (it already
 * stops working the moment it expires — this records and announces it),
 * closes stale access requests, purges spent challenges, opens rotation tasks
 * that have come due, and once a day trims the audit log to its retention.
 *
 * Gated on features.credentialVault and on the vault being configured, read
 * at run time so switching the module on needs no restart.
 */

import cron from "node-cron";
import { createRequire } from "module";
import { runMaintenance, vaultConfigurationStatus } from "../services/credentialVaultService.js";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

let running = false;

async function tick({ purgeAudit }) {
  if (!features.credentialVault || running) return;
  if (!vaultConfigurationStatus().configured) return;
  running = true;
  try {
    const summary = await runMaintenance({ purgeAudit });
    const changed = Object.values(summary).some((n) => n > 0);
    if (changed) console.log("[credentialVaultCron]", JSON.stringify(summary));
  } catch (error) {
    console.error("[credentialVaultCron] maintenance failed:", error?.message);
  } finally {
    running = false;
  }
}

cron.schedule("*/10 * * * *", () => tick({ purgeAudit: false }));
cron.schedule("17 3 * * *", () => tick({ purgeAudit: true }));
