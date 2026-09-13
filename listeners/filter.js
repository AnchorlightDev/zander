import { Listener } from "@sapphire/framework";
import { EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../features.json");
import { isDbHealthy } from "../controllers/databaseController.js";

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
        const filterURL = `${process.env.siteAddress}/api/filter`;
        const bodyJSON = {
          content: message.content,
          discordId: message.author.id,
          discordUsername: message.author.username,
        };

        const response = await fetch(filterURL, {
          method: "POST",
          body: JSON.stringify(bodyJSON),
          headers: {
            "Content-Type": "application/json",
            "x-access-token": process.env.apiKey,
          },
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
