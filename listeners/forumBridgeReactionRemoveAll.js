import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleReactionRemoveAll } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord messageReactionRemoveAll -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeReactionRemoveAllListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageReactionRemoveAll",
    });
  }

  async run(message) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleReactionRemoveAll(message);
    } catch (error) {
      console.error("[forumBridge] messageReactionRemoveAll failed:", error);
    }
  }
}
