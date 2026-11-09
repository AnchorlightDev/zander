import { describe, expect, it } from "vitest";
import { renderWrappedCard } from "../../lib/wrapped/card.js";

const payload = {
  period: { year: 2025, label: "2025" },
  user: { username: "Ben<>&", uuid: "u" },
  stats: {
    playtime: { display: "142h", value: 511200 },
    sessions: { value: 88 },
    tenure: { firstSeen: "2021-03-14T09:00:00.000Z" },
    discordMessages: { value: 412 },
    voiceMinutes: { display: "3h 56m", value: 236 },
    reputation: { level: 7 },
    topCommand: { command: "spawn" },
    minecraft: {
      blocksMined: 128455, mobsKilled: 4210, distanceCm: 61_500_000,
      breadCrafted: 312, fishCaught: 188,
      topBlock: { block: "minecraft:deepslate", count: 41230 },
    },
    shopPurchases: { value: 74, topItem: { itemId: "minecraft:oak_planks", count: 22 } },
  },
  vibe: { label: "Chatty Grinder" },
};

describe("renderWrappedCard", () => {
  it("produces a 1080x1920 (story-format) svg recapping the stats that have data", () => {
    const svg = renderWrappedCard(payload);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1080"');
    expect(svg).toContain('height="1920"');
    expect(svg).toContain("142h");
    expect(svg).toContain("/spawn");
    expect(svg).toContain("Chatty Grinder");
    expect(svg).toContain("2021 March 14"); // tenure
    // new stats now recapped on the card
    expect(svg).toContain("128,455"); // blocks mined
    expect(svg).toContain("Deepslate"); // favourite block
    expect(svg).toContain("615 km"); // distance
    expect(svg).toContain("Oak Planks"); // shop top item
  });

  it("omits stats with no data instead of printing a dash", () => {
    const svg = renderWrappedCard({
      period: { label: "2025" },
      user: { username: "Nobody" },
      stats: { playtime: { value: 0 }, sessions: { value: 0 } },
    });
    expect(svg).toContain("Nobody");
    expect(svg).not.toContain("Playtime");
    expect(svg).toContain("check back soon");
  });

  it("escapes user-controlled text", () => {
    const svg = renderWrappedCard(payload);
    expect(svg).toContain("Ben&lt;&gt;&amp;");
    expect(svg).not.toContain("Ben<>&");
  });

  it("embeds logo + avatar data URIs when provided", () => {
    const svg = renderWrappedCard(payload, {
      logoDataUri: "data:image/png;base64,AAAA",
      avatarDataUri: "data:image/png;base64,BBBB",
    });
    expect(svg).toContain("data:image/png;base64,AAAA");
    expect(svg).toContain("data:image/png;base64,BBBB");
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it("tolerates a fully sparse payload", () => {
    const svg = renderWrappedCard({ period: { label: "2024" }, user: {}, stats: {} });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Player");
  });
});
