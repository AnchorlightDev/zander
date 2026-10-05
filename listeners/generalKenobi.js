import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

export class GuildMessageListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageCreate",
    });
  }

  run(message) {
    if (message.author.isbot) return;

    if (features.discord.events.generalKenobi) {
      if (message.content.toLowerCase().includes("hello there")) {
        message.channel.send("General Kenobi");
        return;
      }
    }
  }
}
