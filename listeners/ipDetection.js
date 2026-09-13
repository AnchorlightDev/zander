import { Listener } from "@sapphire/framework";
import { Colors, EmbedBuilder } from "discord.js";
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../features.json");

// Phrases that indicate someone is asking for the server IP / how to join.
const IP_PHRASES = [
  "what is the ip",
  "what's the ip",
  "whats the ip",
  "what is the server ip",
  "what's the server ip",
  "whats the server ip",
  "server ip",
  "server address",
  "how do i join",
  "how do you join",
  "how to join",
  "ip address",
  "what ip",
];

export class IpDetectionListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageCreate",
    });
  }

  async run(message) {
    if (message.author.bot) return;
    if (!features?.discord?.events?.ipAutoDetect) return;

    const content = message.content.toLowerCase();
    const matched = IP_PHRASES.some((phrase) => content.includes(phrase));
    if (!matched) return;

    try {
      const fetchURL = `${process.env.siteAddress}/api/server/get?type=EXTERNAL`;
      const response = await fetch(fetchURL, {
        headers: { "x-access-token": process.env.apiKey },
      });
      const apiData = await response.json();

      if (!apiData.data) {
        const noServersEmbed = new EmbedBuilder()
          .setTitle("No Servers")
          .setDescription(apiData.message)
          .setColor(Colors.Red);

        await message.reply({ embeds: [noServersEmbed] });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("Network Servers")
        .setDescription("Get started! Jump on and play with our community!")
        .setColor(Colors.DarkGold);

      apiData.data.forEach((server) => {
        embed.addFields({
          name: server.displayName,
          value: server.serverConnectionAddress,
          inline: true,
        });
      });

      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error("[IpDetection] Failed to fetch server list:", err);
    }
  }
}
