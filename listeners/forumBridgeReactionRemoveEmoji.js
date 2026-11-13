import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleReactionRemoveEmoji } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord messageReactionRemoveEmoji -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeReactionRemoveEmojiListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageReactionRemoveEmoji",
    });
  }

  async run(reaction) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleReactionRemoveEmoji(reaction);
    } catch (error) {
      console.error("[forumBridge] messageReactionRemoveEmoji failed:", error);
    }
  }
}
