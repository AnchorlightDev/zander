/**
 * services/credentialVaultNotifications.js
 *
 * Delivery for Credential Vault notifications: the in-app bell (and web push,
 * via createNotificationsForUsers) plus an optional Discord webhook
 * (Site Settings → discord.webhooks.credentialVault).
 *
 * Callers only ever pass titles, names and links. Nothing here is given a
 * secret value, so nothing here can leak one.
 */

import { createRequire } from "module";
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { createNotificationsForUsers } from "../controllers/notificationController.js";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";
import { usersWithCapability } from "./credentialVaultService.js";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");

export async function sendVaultNotification({ recipients, excludeUserIds = [], title, message, url }) {
  let userIds = [];
  if (recipients === "admins") userIds = await usersWithCapability({ kind: "vault" }, "manage_vault");
  else if (Array.isArray(recipients)) userIds = recipients;
  const exclude = new Set(excludeUserIds.map(Number));
  userIds = [...new Set(userIds.map(Number))].filter((id) => id > 0 && !exclude.has(id));

  if (userIds.length) {
    await createNotificationsForUsers(userIds, {
      notificationType: "credential_vault",
      title: String(title).slice(0, 255),
      message: String(message).slice(0, 1000),
      url: String(url || "/dashboard/credentials").slice(0, 255),
    });
  }

  // Administrator-facing events also go to the staff webhook when one is set.
  const webhookUrl = config.discord?.webhooks?.credentialVault;
  if (webhookUrl && recipients === "admins") {
    const site = String(process.env.siteAddress || "").replace(/\/$/, "");
    // The webhook channel may be readable by people outside the vault, so it
    // carries only the event title and a link -- no credential names.
    const embed = new MessageBuilder()
      .setTitle(`Credential Vault: ${String(title).slice(0, 200)}`)
      .setDescription("Open the credential vault for details.")
      .setColor("#6f42c1")
      .setTimestamp();
    if (site && url) embed.setURL(`${site}${url}`);
    await sendWebhookMessage(new Webhook(webhookUrl), embed, { context: "credential-vault", retries: 1 });
  }
}
