import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleMessageDeleteBulk } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord messageDeleteBulk -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeMessageDeleteBulkListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageDeleteBulk",
    });
  }

  async run(messages) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleMessageDeleteBulk(messages);
    } catch (error) {
      console.error("[forumBridge] messageDeleteBulk failed:", error);
    }
  }
}
