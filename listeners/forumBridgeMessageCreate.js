import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleMessageCreate } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord messageCreate -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeMessageCreateListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageCreate",
    });
  }

  async run(message) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleMessageCreate(message);
    } catch (error) {
      console.error("[forumBridge] messageCreate failed:", error);
    }
  }
}
