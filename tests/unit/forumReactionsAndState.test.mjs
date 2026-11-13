import { describe, expect, it, vi } from "vitest";
import {
  WEB_REACTION_PALETTE,
  discordReactIdentifier,
  emojiKeyFromDiscord,
  isAllowedWebReaction,
  parseEmojiKey,
  summariseReactions,
} from "../../lib/forums/reactionEmoji.mjs";
import { emitForumEvent, forumEvents, FORUM_EVENTS } from "../../lib/forums/forumEvents.mjs";
import {
  cachedBridgeForCategory,
  cachedBridgeForChannel,
  invalidateBridgeCache,
  isBridgeCacheFresh,
  isSelfChange,
  markSelfChange,
  runSerial,
  setBridgeCache,
} from "../../lib/forums/forumBridgeState.mjs";
import { diffLinkedRole } from "../../lib/discord/linkedRoleSync.mjs";

describe("reaction emoji keys", () => {
  it("accepts unicode emoji and Discord custom emoji", () => {
    expect(parseEmojiKey("👍")).toEqual({ type: "unicode", key: "👍" });
    expect(parseEmojiKey("🇦🇺")?.type).toBe("unicode");
    expect(parseEmojiKey("<a:dance:123456789012345678>")).toMatchObject({ type: "custom", animated: true, id: "123456789012345678" });
  });

  it("rejects text and markup", () => {
    for (const bad of ["hello", "<b>", "👍 <script>", "", null, "x".repeat(50)]) {
      expect(parseEmojiKey(bad)).toBeNull();
    }
  });

  it("round-trips discord.js emoji objects", () => {
    expect(emojiKeyFromDiscord({ id: null, name: "🔥" })).toBe("🔥");
    expect(emojiKeyFromDiscord({ id: "123456789012345678", name: "pepe", animated: false })).toBe("<:pepe:123456789012345678>");
    expect(discordReactIdentifier("<:pepe:123456789012345678>")).toBe("123456789012345678");
    expect(discordReactIdentifier("🔥")).toBe("🔥");
  });

  it("lets the website use the palette, or +1 an emoji already on the post", () => {
    expect(isAllowedWebReaction(WEB_REACTION_PALETTE[0])).toBe(true);
    expect(isAllowedWebReaction("<:pepe:123456789012345678>")).toBe(false);
    expect(isAllowedWebReaction("<:pepe:123456789012345678>", ["<:pepe:123456789012345678>"])).toBe(true);
    expect(isAllowedWebReaction("🦀")).toBe(false);
  });

  it("summarises reactions per emoji, marking the viewer's own", () => {
    const summary = summariseReactions(
      [
        { emoji: "👍", userId: 1, username: "A" },
        { emoji: "👍", userId: 2, username: "B" },
        { emoji: "🔥", userId: 2, username: "B" },
      ],
      2
    );
    expect(summary[0]).toMatchObject({ count: 2, reacted: true, users: ["A", "B"] });
    expect(summary[1]).toMatchObject({ count: 1, reacted: true });
  });
});

describe("forum events", () => {
  it("defaults origin to web and isolates listener errors", () => {
    const seen = [];
    const ok = (event) => seen.push(event);
    const boom = () => {
      throw new Error("listener failed");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    forumEvents.on(FORUM_EVENTS.POST_CREATED, boom);
    forumEvents.on(FORUM_EVENTS.POST_CREATED, ok);
    expect(() => emitForumEvent(FORUM_EVENTS.POST_CREATED, { postId: 1 })).not.toThrow();
    expect(seen).toEqual([{ origin: "web", postId: 1 }]);
    forumEvents.off(FORUM_EVENTS.POST_CREATED, boom);
    forumEvents.off(FORUM_EVENTS.POST_CREATED, ok);
    spy.mockRestore();
  });
});

describe("bridge state", () => {
  it("remembers the bridge's own thread changes briefly", () => {
    markSelfChange("t1", 1000);
    expect(isSelfChange("t1", 2000)).toBe(true);
    expect(isSelfChange("t1", 1000 + 31_000)).toBe(false);
    expect(isSelfChange("t2", 2000)).toBe(false);
  });

  it("caches bridges by category and channel", () => {
    setBridgeCache([{ categoryId: 4, channelId: "999" }], 0);
    expect(cachedBridgeForCategory(4)?.channelId).toBe("999");
    expect(cachedBridgeForChannel("999")?.categoryId).toBe(4);
    expect(isBridgeCacheFresh(10_000)).toBe(true);
    expect(isBridgeCacheFresh(120_000)).toBe(false);
    invalidateBridgeCache();
    expect(cachedBridgeForCategory(4)).toBeNull();
  });

  it("runs tasks for the same thread in order", async () => {
    const order = [];
    const slow = runSerial("thread", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("starter");
    });
    const fast = runSerial("thread", async () => order.push("reply"));
    await Promise.all([slow, fast]);
    expect(order).toEqual(["starter", "reply"]);
  });

  it("keeps going after a failed task", async () => {
    const failed = runSerial("t3", async () => {
      throw new Error("x");
    });
    await expect(failed).rejects.toThrow("x");
    await expect(runSerial("t3", async () => "ok")).resolves.toBe("ok");
  });
});

describe("diffLinkedRole", () => {
  it("adds the role to linked members and removes it from everyone else, skipping bots", () => {
    const { toAdd, toRemove } = diffLinkedRole(
      [
        { id: "1", bot: false, roleIds: [] },
        { id: "2", bot: false, roleIds: ["R"] },
        { id: "3", bot: false, roleIds: ["R"] },
        { id: "4", bot: true, roleIds: [] },
      ],
      new Set(["1", "3", "4"]),
      "R"
    );
    expect(toAdd).toEqual(["1"]);
    expect(toRemove).toEqual(["2"]);
  });
});
