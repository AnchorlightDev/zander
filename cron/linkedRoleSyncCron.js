/**
 * cron/linkedRoleSyncCron.js
 *
 * Every 30 minutes, make sure the "Linked account" Discord role
 * (config.discord.roles.linked) is held by exactly the members whose Discord
 * is linked to a real, enabled website account. Link/unlink/join already sync
 * one member at a time; this catches accounts disabled, merged or unlinked by
 * other paths. Does nothing until the role is configured.
 */

import cron from "node-cron";
import { reconcileLinkedRoles } from "../lib/discord/linkedRoleSync.mjs";

const linkedRoleTask = cron.schedule("*/30 * * * *", async () => {
  const result = await reconcileLinkedRoles();
  if (result.ok && (result.added || result.removed)) {
    console.log(`[linkedRoleSyncCron] Linked role: +${result.added} / -${result.removed}`);
  }
});

linkedRoleTask.start();
