/**
 * api/routes/filter.js
 *
 * POST /api/filter — checks text for zander's own callers: profile edits
 * (api/routes/user.js) and the Velocity/Waterfall proxy plugins' chat.
 *
 * MineMonitor owns content filtering (it filters Discord with its own bot and
 * in-game chat through its agents, via Purify). This route asks MineMonitor's
 * POST /api/filter for the verdict, keeps the contract zander's callers rely
 * on -- `{ success: false }` means "block it" -- and sends the staff alert.
 *
 * Configuration:
 *   Settings → Automation → MineMonitor base URL (or MINEMONITOR_BASE_URL)
 *   MINEMONITOR_CONNECTION_TOKEN  a MineMonitor connection token with the
 *                                 `filter.check` scope (and `wrapped.read`
 *                                 for Wrapped)
 *
 * If MineMonitor is not configured or does not answer, content is let
 * through (fail open): a filter outage must not silence all chat.
 */

import { isFeatureEnabled, optional, required } from "../common.js";
import { UserGetter } from "../../controllers/userController.js";
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { Colors } from "discord.js";
import { sendWebhookMessage } from "../../lib/discord/webhooks.mjs";

const FILTER_TIMEOUT_MS = 5000;
const CLEAN = { success: true, message: "Content is clean. No flags detected." };

let warnedUnconfigured = false;

/**
 * Ask MineMonitor about one piece of content.
 * @returns {Promise<{flagged:boolean, details:string[], dryRun:boolean} | null>} null when unavailable
 */
async function checkWithMineMonitor(content, config) {
  const baseUrl = String(config.wrapped?.minemonitor?.baseUrl || process.env.MINEMONITOR_BASE_URL || "").replace(/\/+$/, "");
  const token = process.env.MINEMONITOR_CONNECTION_TOKEN;
  if (!baseUrl || !token) {
    if (!warnedUnconfigured) {
      console.warn("[filter] MineMonitor base URL / MINEMONITOR_CONNECTION_TOKEN are not set — text filtering is off.");
      warnedUnconfigured = true;
    }
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILTER_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/filter`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[filter] MineMonitor responded ${response.status}; letting content through.`);
      return null;
    }
    const data = await response.json();
    // ok:false is MineMonitor saying its own check failed -- fail open.
    if (data?.ok === false) return null;
    return {
      flagged: data?.flagged === true,
      details: Array.isArray(data?.details) ? data.details.map(String) : [],
      dryRun: data?.dryRun === true,
    };
  } catch (error) {
    console.error("[filter] MineMonitor unavailable; letting content through:", error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep only flags whose filter is switched on in Modules: link flags follow
 * "Link filter", everything else (profanity) follows "Phrase filter".
 * Prefixes are Purify's flag messages, passed through by MineMonitor.
 */
function relevantFlags(details, features) {
  const isLinkFlag = (d) => /^(Manually Blocked Domain|Malicious Link Detected|Blocked Category Detected)\b/.test(d);
  return details.filter((d) => (isLinkFlag(d) ? features.filter.link : features.filter.phrase));
}

export default function filterApiRoute(app, client, config, db, features, lang) {
  app.post("/api/filter", async function (req, res) {
    if (!features.filter.phrase && !features.filter.link) {
      if (!isFeatureEnabled(false, res, lang)) return;
    }

    const content = required(req.body, "content", res);
    if (res.sent) return;
    const username = optional(req.body, "username");
    const discordId = optional(req.body, "discordId");
    const discordUsername = optional(req.body, "discordUsername");

    try {
      const result = await checkWithMineMonitor(String(content), config);
      if (!result || !result.flagged) return res.send(CLEAN);

      const flaggedFor = relevantFlags(result.details, features);
      if (flaggedFor.length === 0) return res.send(CLEAN);

      let userData = null;
      if (username) userData = await new UserGetter().byUsername(username);
      if (discordId) userData = await new UserGetter().byDiscordId(discordId);

      let detectedUser = "Unknown";
      if (userData?.username) detectedUser = `${userData.username} (Verified)`;
      else if (discordUsername) detectedUser = `${discordUsername} (Unverified)`;
      else if (discordId) detectedUser = `<@${discordId}> (Unverified)`;
      else if (username) detectedUser = `${username} (Unverified)`;

      const embed = new MessageBuilder()
        .setTitle(result.dryRun ? `🔵 Filter Flagged (notify only)` : `🔵 Filter Flagged`)
        .addField("Detected User", detectedUser, true)
        .addField("Flagged Issues", flaggedFor.join(", ").slice(0, 1000), true)
        .addField("Content", String(content).slice(0, 1000), false)
        .setColor(Colors.Red)
        .setTimestamp();

      const webhookSent = await sendWebhookMessage(new Webhook(config.discord.webhooks.staffChannel), embed, {
        context: "api/filter",
      });

      // MineMonitor's notify-only mode: staff hear about it, nothing is blocked.
      if (result.dryRun) return res.send(CLEAN);

      return res.send({
        success: false,
        message: webhookSent
          ? lang.filter.phraseCaught || "Content flagged."
          : "Content flagged, but staff could not be notified.",
      });
    } catch (error) {
      console.error("[filter] Error processing request:", error);
      // Fail open, same as a MineMonitor outage: callers treat success:false as "block".
      if (!res.sent) return res.send(CLEAN);
    }
  });
}
