import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleReactionAdd } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord messageReactionAdd -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeReactionAddListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "messageReactionAdd",
    });
  }

  async run(reaction, user) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleReactionAdd(reaction, user);
    } catch (error) {
      console.error("[forumBridge] messageReactionAdd failed:", error);
    }
  }
}
