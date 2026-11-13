import { Listener } from "@sapphire/framework";
import { createRequire } from "module";
import { handleThreadDelete } from "../lib/forums/forumBridgeDiscord.mjs";

const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

/** Forum bridge: Discord threadDelete -> website forums. See lib/forums/forumBridgeDiscord.mjs. */
export class ForumBridgeThreadDeleteListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      once: false,
      event: "threadDelete",
    });
  }

  async run(thread) {
    if (!features.discord?.forumBridge) return;
    try {
      await handleThreadDelete(thread);
    } catch (error) {
      console.error("[forumBridge] threadDelete failed:", error);
    }
  }
}
