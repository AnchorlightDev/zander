import { Listener, container } from "@sapphire/framework";
import { EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");
const config = require("../lib/config/config.cjs");
import { cachedInviteResolver, stripOwnServerLinks } from "../lib/discord/inviteAllowlist.mjs";
import { isDbHealthy } from "../controllers/databaseController.js";

import { internalApiHeaders } from "../api/common.js";
// Which guild an invite belongs to, cached (see lib/discord/inviteAllowlist.mjs).
const resolveInviteGuildId = cachedInviteResolver(async (code) => {
  const invite = await container.client.fetchInvite(code);
  return invite?.guild?.id ?? null;
});

export class GuildMessageListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageCreate",
    });
  }

  async run(message) {
    // Check if the author is a bot
    if (message.author.bot) return;

    // Skip filtering entirely when the database is unreachable — the filter API
    // relies on DB-backed user lookups and the health of the overall service.
    if (isDbHealthy() === false) return;

    if (features.filter.link || features.filter.phrase) {
      try {
        // Links to this server (its invites, event and message links) are fine
        // inside this server; only the rest of the message is checked. Other
        // servers' invites are still caught.
        const guildId = config.discord?.guildId;
        const content =
          message.guildId && message.guildId === guildId
            ? await stripOwnServerLinks(message.content, { guildId, resolveInviteGuildId })
            : message.content;
        if (!content || !content.trim()) return;

        const filterURL = `${process.env.siteAddress}/api/filter`;
        const bodyJSON = {
          content,
          discordId: message.author.id,
          discordUsername: message.author.username,
        };

        const response = await fetch(filterURL, {
          method: "POST",
          body: JSON.stringify(bodyJSON),
          headers: internalApiHeaders({ "Content-Type": "application/json" }),
        });

        // If the API is unavailable (e.g. DB down), skip filtering rather than
        // treating the error response as a filter match.
        if (!response.ok) return;

        const dataResponse = await response.json();

        if (dataResponse.success === false) {
          // Create an embed to warn the user
          const embed = new EmbedBuilder()
            .setTitle(`Prohibited content detected!`)
            .setDescription(
              `\`${message.author.username}\`, please refrain from using prohibited content/phrases. Continued violations may result in penalties.`
            )
            .setColor(`#ff3333`);

          // Send the embed to the channel
          await message.reply({ embeds: [embed] });

          // Delete the message after a short delay to ensure the embed is sent first
          setTimeout(async () => {
            if (message.deletable) {
              await message.delete();
            }
          }, 500); // Delay of 500ms before deleting the message
        }
      } catch (error) {
        console.error("filter listener failed to process message", error);
      }
    }
  }
}
