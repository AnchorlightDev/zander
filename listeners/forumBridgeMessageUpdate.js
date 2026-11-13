import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleMessageUpdate } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord messageUpdate -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeMessageUpdateListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageUpdate",
    });
  }

  async run(oldMessage, newMessage) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleMessageUpdate(oldMessage, newMessage);
    } catch (error) {
      console.error("[forumBridge] messageUpdate failed:", error);
    }
  }
}
