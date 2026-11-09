import { describe, expect, it } from "vitest";
import { buildWrappedSlides } from "../../lib/wrapped/slides.js";
import { renderWrappedSlideCard, SLIDE_CARD_W, SLIDE_CARD_H } from "../../lib/wrapped/slideCard.js";

const richPayload = {
  period: { year: 2025, label: "2025", start: "2025-01-01", end: "2025-12-31" },
  user: { userId: 7, username: "Zephyr", uuid: "u-7" },
  vibe: { label: "Chatty Grinder", blurb: "You put in the hours." },
  stats: {
    playtime: {
      value: 3600 * 40, display: "40h", rank: 3, total: 20,
      neighbors: {
        rank: 3, total: 20,
        rows: [
          { rank: 2, name: "Alex", value: 3600 * 50, you: false },
          { rank: 3, name: "You", value: 3600 * 40, you: true },
          { rank: 4, name: "Sam", value: 3600 * 30, you: false },
        ],
      },
    },
    sessions: { value: 12, rank: 5, total: 20 },
    avgSession: { value: 1200, display: "20m" },
    tenure: { firstSeen: "2023-02-01", days: 800 },
    mostActiveDay: { date: "2025-06-14", seconds: 7200 },
    mostActiveMonth: { month: "2025-06", seconds: 90000 },
    discordMessages: {
      value: 300, rank: 1, total: 15,
      neighbors: {
        rank: 1, total: 15,
        rows: [
          { rank: 1, name: "You", value: 300, you: true },
          { rank: 2, name: "Jamie", value: 250, you: false },
        ],
      },
    },
    discordReactions: { value: 88, rank: 4, total: 15 },
    voiceMinutes: { value: 120, display: "2h", rank: 2, total: 10, channelName: "General VC" },
    reputation: { value: 900, level: 7, lifetime: 3120, rank: 6, total: 30 },
    shopPurchases: {
      value: 42, rank: 3, total: 40,
      totalSpent: 1234.5,
      topItem: { itemId: "minecraft:diamond", count: 15 },
      topOwner: { uuid: "o-1", name: "ShopkeeperSue", count: 9 },
      since: null, sinceTracking: false,
    },
    minecraft: {
      sinceTracking: false, since: null,
      blocksMined: 12345, mobsKilled: 678, distanceCm: 4_200_000,
      breadCrafted: 90, fishCaught: 33,
      topBlock: { block: "minecraft:deepslate", count: 4000 },
    },
    topBlockBoard: {
      blockId: "minecraft:deepslate", rank: 2, total: 17, excludedNoBaseline: 3,
      rows: [
        { rank: 1, name: "Digby", value: 9000, avatar: "https://cdn/d.png", you: false },
        { rank: 2, name: "You", value: 4000, avatar: null, you: true },
        { rank: 3, name: "Mole", value: 2500, avatar: null, you: false },
      ],
    },
    topCommand: { command: "/spawn", count: 42 },
    friend: { name: "Robin", minutes: 55 },
    ingameFriend: { name: "Casey", minutes: 130 },
  },
};

describe("buildWrappedslides", () => {
  it("opens with the title slide and closes with the vibe slide", () => {
    const slides = buildWrappedSlides(richPayload);
    expect(slides[0]).toMatchObject({ key: "intro", kind: "title" });
    expect(slides[slides.length - 1]).toMatchObject({ key: "vibe", kind: "vibe", label: "Chatty Grinder" });
  });

  it("emits every stat slide and places each board right after its stat", () => {
    const keys = buildWrappedSlides(richPayload).map((s) => s.key);
    expect(keys).toEqual([
      "intro",
      "playtime", "playtimeBoard",
      "sessions",
      "tenure",
      "mostActiveDay",
      "mostActiveMonth",
      "blocksMined", "topBlock", "topBlockBoard", "mobsKilled", "distance", "bread", "fish",
      "discordMessages", "messagesBoard",
      "discordReactions",
      "voiceMinutes",
      "reputation",
      "shopPurchases", "shopOwner",
      "topCommand",
      "friend",
      "ingameFriend",
      "vibe",
    ]);
  });

  it("pre-formats board row values and rank lines", () => {
    const board = buildWrappedSlides(richPayload).find((s) => s.key === "playtimeBoard");
    expect(board.neighbors.rows.map((r) => r.displayValue)).toEqual(["2d 2h", "1d 16h", "1d 6h"]);
    const playtime = buildWrappedSlides(richPayload).find((s) => s.key === "playtime");
    expect(playtime.rank).toBe("You're #3 of 20 players");
  });

  it("drops a board when there is no neighbourhood, and hides zero-value stats", () => {
    const slim = {
      period: richPayload.period,
      user: richPayload.user,
      vibe: richPayload.vibe,
      stats: { playtime: { value: 3600, display: "1h", rank: 9, total: 9 }, discordMessages: { value: 0 } },
    };
    const keys = buildWrappedSlides(slim).map((s) => s.key);
    expect(keys).toEqual(["intro", "playtime", "vibe"]);
  });

  it("emits voice + reputation board slides with formatted values and avatars", () => {
    const p = JSON.parse(JSON.stringify(richPayload));
    p.stats.voiceMinutes.neighbors = {
      rank: 2, total: 10,
      rows: [
        { rank: 1, name: "Alex", value: 200, avatar: "https://cdn/a.png", you: false },
        { rank: 2, name: "You", value: 120, avatar: "https://cdn/me.png", you: true },
        { rank: 3, name: "Sam", value: 90, avatar: null, you: false },
      ],
    };
    p.stats.reputation.neighbors = {
      rank: 6, total: 30,
      rows: [
        { rank: 5, name: "Jo", value: 1000, avatar: null, you: false },
        { rank: 6, name: "You", value: 900, avatar: null, you: true },
        { rank: 7, name: "Kai", value: 800, avatar: null, you: false },
      ],
    };
    const slides = buildWrappedSlides(p);
    expect(slides.find((s) => s.key === "voiceMinutes").sub).toBe("most of it in General VC");
    const voiceBoard = slides.find((s) => s.key === "voiceBoard");
    const repBoard = slides.find((s) => s.key === "reputationBoard");
    expect(voiceBoard.neighbors.rows.map((r) => r.displayValue)).toEqual(["3h 20m", "2h", "1h 30m"]);
    expect(voiceBoard.neighbors.rows[0].avatar).toBe("https://cdn/a.png");
    expect(repBoard.neighbors.rows.map((r) => r.displayValue)).toEqual(["1,000 rep", "900 rep", "800 rep"]);
    // each board sits right after its stat slide
    const keys = slides.map((s) => s.key);
    expect(keys.indexOf("voiceBoard")).toBe(keys.indexOf("voiceMinutes") + 1);
    expect(keys.indexOf("reputationBoard")).toBe(keys.indexOf("reputation") + 1);
  });

  it("builds the vanilla MC-stat slides from the minecraft block", () => {
    const byKey = Object.fromEntries(buildWrappedSlides(richPayload).map((s) => [s.key, s]));
    expect(byKey.blocksMined.stat).toBe("12,345 blocks");
    expect(byKey.topBlock.stat).toBe("Deepslate");
    expect(byKey.topBlock.sub).toBe("4,000 of them");
    expect(byKey.mobsKilled.stat).toBe("678 mobs");
    expect(byKey.distance.stat).toBe("42 km"); // 4,200,000 cm
    expect(byKey.distance.sub).toContain("42,000 blocks");
    expect(byKey.bread.stat).toBe("90 loaves of bread");
    expect(byKey.fish.stat).toBe("33 fish");
  });

  it("notes 'since we started counting' when the MC stats have no baseline", () => {
    const p = JSON.parse(JSON.stringify(richPayload));
    p.stats.minecraft.sinceTracking = true;
    const slides = buildWrappedSlides(p);
    expect(slides.find((s) => s.key === "blocksMined").sub).toBe("since we started counting");
    expect(slides.find((s) => s.key === "topBlock").sub).toBe("4,000 of them · since we started counting");
  });

  it("skips MC slides whose value is zero", () => {
    const p = JSON.parse(JSON.stringify(richPayload));
    p.stats.minecraft = { sinceTracking: false, since: null, blocksMined: 5, mobsKilled: 0, distanceCm: 0, breadCrafted: 0, fishCaught: 0, topBlock: null };
    const keys = buildWrappedSlides(p).map((s) => s.key);
    expect(keys).toContain("blocksMined");
    expect(keys).not.toContain("mobsKilled");
    expect(keys).not.toContain("topBlock");
    expect(keys).not.toContain("distance");
  });

  it("builds the shop-purchase slides (stat + favourite shopkeeper)", () => {
    const byKey = Object.fromEntries(buildWrappedSlides(richPayload).map((s) => [s.key, s]));
    expect(byKey.shopPurchases.stat).toBe("42 purchases");
    expect(byKey.shopPurchases.sub).toContain("Diamond");
    expect(byKey.shopPurchases.rank).toBe("You're #3 of 40 shoppers");
    expect(byKey.shopOwner.stat).toBe("ShopkeeperSue");
    expect(byKey.shopOwner.sub).toBe("9 buys from their shop");
  });

  it("shop slide notes 'since we started counting' when tracking is partial", () => {
    const p = JSON.parse(JSON.stringify(richPayload));
    p.stats.shopPurchases.sinceTracking = true;
    p.stats.shopPurchases.since = "2026-03-14T00:00:00.000Z";
    const sp = buildWrappedSlides(p).find((s) => s.key === "shopPurchases");
    expect(sp.sub).toContain("since we started counting in March 2026");
  });

  it("emits a shopBoard when a neighbourhood is present", () => {
    const p = JSON.parse(JSON.stringify(richPayload));
    p.stats.shopPurchases.neighbors = {
      rank: 3, total: 40,
      rows: [
        { rank: 2, name: "Kai", value: 50, avatar: null, you: false },
        { rank: 3, name: "You", value: 42, avatar: null, you: true },
        { rank: 4, name: "Lee", value: 30, avatar: null, you: false },
      ],
    };
    const board = buildWrappedSlides(p).find((s) => s.key === "shopBoard");
    expect(board.kind).toBe("board");
    expect(board.neighbors.rows.map((r) => r.displayValue)).toEqual(["50 buys", "42 buys", "30 buys"]);
  });

  it("pairs a topBlockBoard slide right after topBlock", () => {
    const slides = buildWrappedSlides(richPayload);
    const keys = slides.map((s) => s.key);
    expect(keys.indexOf("topBlockBoard")).toBe(keys.indexOf("topBlock") + 1);
    const board = slides.find((s) => s.key === "topBlockBoard");
    expect(board.title).toBe("Who else was chasing Deepslate");
    expect(board.neighbors.rank).toBe(2);
    expect(board.neighbors.total).toBe(17);
    expect(board.neighbors.rows.map((r) => r.displayValue)).toEqual(["9,000", "4,000", "2,500"]);
    expect(board.neighbors.rows.find((r) => r.you).name).toBe("You");
  });

  it("topBlockBoard omits the rank line when the viewer isn't in the top 5", () => {
    const p = JSON.parse(JSON.stringify(richPayload));
    p.stats.topBlockBoard.rank = null;
    p.stats.topBlockBoard.rows = p.stats.topBlockBoard.rows.map((r) => ({ ...r, you: false, name: r.name === "You" ? "Ghost" : r.name }));
    const board = buildWrappedSlides(p).find((s) => s.key === "topBlockBoard");
    expect(board.neighbors.rank).toBeNull();
    expect(board.neighbors.total).toBe(17);
  });

  it("falls back to a 'still being written' slide when nothing qualifies", () => {
    const keys = buildWrappedSlides({ period: richPayload.period, user: richPayload.user, stats: {} }).map((s) => s.key);
    expect(keys).toEqual(["intro", "empty", "vibe"]);
  });
});

describe("renderWrappedSlideCard", () => {
  const ctx = { user: richPayload.user, period: richPayload.period, siteName: "Crafting For Christ" };

  it("renders a 1080x1920 SVG for every slide kind", () => {
    for (const slide of buildWrappedSlides(richPayload)) {
      const svg = renderWrappedSlideCard(slide, ctx);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain(`width="${SLIDE_CARD_W}"`);
      expect(svg).toContain(`height="${SLIDE_CARD_H}"`);
      expect(svg).toContain("Wrapped 2025");
    }
  });

  it("escapes user-controlled text", () => {
    const slide = { kind: "stat", mood: "pop", emoji: "💬", flavor: "You and <script>x</script>", stat: "1 & 2" };
    const svg = renderWrappedSlideCard(slide, ctx);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>x</script>");
    expect(svg).toContain("1 &amp; 2");
  });
});
