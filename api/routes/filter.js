/**
 * api/routes/filter.js
 *
 * POST /api/filter — the one place chat and profile text is checked. Called by
 * the Discord bot (listeners/filter.js), the Velocity/Waterfall proxy plugins
 * for in-game chat, and profile edits (api/routes/user.js).
 *
 * The checking itself is done by the Purify microservice (profanity, a manual
 * domain blocklist that catches bare `discord.gg/...` invites, and VirusTotal
 * link scanning). This route keeps the contract its callers already rely on --
 * `{ success: false }` means "block it" -- and sends the staff alert.
 *
 * Environment:
 *   PURIFY_URL      base URL of the Purify service, e.g. https://purify.example.net
 *   PURIFY_API_KEY  Purify's API_KEY, sent as a bearer token
 *
 * If Purify is not configured or does not answer, content is let through
 * (fail open): a filter outage must not silence all chat.
 */

import { isFeatureEnabled, optional, required } from "../common.js";
import { UserGetter } from "../../controllers/userController.js";
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { Colors } from "discord.js";
import { sendWebhookMessage } from "../../lib/discord/webhooks.mjs";

const PURIFY_TIMEOUT_MS = 5000;
const CLEAN = { success: true, message: "Content is clean. No flags detected." };

let warnedUnconfigured = false;

/**
 * Ask Purify about one piece of content.
 * @returns {Promise<{flagged:boolean, details:string[]} | null>} null when unavailable
 */
async function checkWithPurify(content) {
  const baseUrl = String(process.env.PURIFY_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.PURIFY_API_KEY;
  if (!baseUrl || !apiKey) {
    if (!warnedUnconfigured) {
      console.warn("[filter] PURIFY_URL / PURIFY_API_KEY are not set — chat filtering is off.");
      warnedUnconfigured = true;
    }
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PURIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/filter`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[filter] Purify responded ${response.status}; letting content through.`);
      return null;
    }
    const data = await response.json();
    return {
      flagged: data?.flagged === true,
      details: Array.isArray(data?.details) ? data.details.map(String) : [],
    };
  } catch (error) {
    console.error("[filter] Purify unavailable; letting content through:", error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep only flags whose filter is switched on in Modules: link flags follow
 * "Link filter", everything else (profanity) follows "Phrase filter".
 * Prefixes are Purify's flag messages (src/services/filterService.js).
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
      const result = await checkWithPurify(String(content));
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
        .setTitle(`🔵 Filter Flagged`)
        .addField("Detected User", detectedUser, true)
        .addField("Flagged Issues", flaggedFor.join(", ").slice(0, 1000), true)
        .addField("Content", String(content).slice(0, 1000), false)
        .setColor(Colors.Red)
        .setTimestamp();

      const webhookSent = await sendWebhookMessage(new Webhook(config.discord.webhooks.staffChannel), embed, {
        context: "api/filter",
      });

      return res.send({
        success: false,
        message: webhookSent
          ? lang.filter.phraseCaught || "Content flagged."
          : "Content flagged, but staff could not be notified.",
      });
    } catch (error) {
      console.error("[filter] Error processing request:", error);
      // Fail open, same as a Purify outage: callers treat success:false as "block".
      if (!res.sent) return res.send(CLEAN);
    }
  });
}
