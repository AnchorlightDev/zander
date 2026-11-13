import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleReactionRemove } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord messageReactionRemove -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeReactionRemoveListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageReactionRemove",
    });
  }

  async run(reaction, user) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleReactionRemove(reaction, user);
    } catch (error) {
      console.error("[forumBridge] messageReactionRemove failed:", error);
    }
  }
}
