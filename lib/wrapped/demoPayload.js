/**
 * A fully-populated fake Wrapped payload for visual testing of the deck and the
 * summary / per-slide cards — no MineMonitor, no real user stats needed.
 * Same shape as a persisted `wrappedRuns.payload`.
 */

import { humanizeDuration } from "./derive.js";

// Keep in step with services/wrapped/wrappedService.js WRAPPED_PAYLOAD_VERSION.
const WRAPPED_PAYLOAD_VERSION = 1;

const NAMES = [
  "AshBuilds", "PixelPriya", "CoalMiner_Kev", "Zephyr", "MelodyMiner", "Fluffspud",
  "The_Aussie_BFG", "Skyemorre", "Cactusbaddy5", "LapisGamer05", "QuietQuokka", "DiggerDan",
];

function head(uuidish) {
  return `https://crafthead.net/avatar/${encodeURIComponent(uuidish)}`;
}

/** A ±2 neighbourhood centred on `rank` out of `total`, "You" at `rank`. */
function board(rank, total, valueAt) {
  const rows = [];
  for (let r = Math.max(1, rank - 2); r <= Math.min(total, rank + 2); r++) {
    const you = r === rank;
    rows.push({
      rank: r,
      name: you ? "You" : NAMES[(r * 7) % NAMES.length],
      value: valueAt(r),
      avatar: you ? null : head(`demo-${r}`),
      you,
    });
  }
  return { rank, total, rows };
}

/**
 * @param {{ siteName?: string, username?: string, period?: object }} [opts]
 */
export function buildDemoWrappedPayload(opts = {}) {
  const username = opts.username || "DemoPlayer";
  const now = new Date();
  const year = now.getUTCFullYear();
  const period =
    opts.period && opts.period.start
      ? {
          year: opts.period.year ?? year,
          label: opts.period.label ?? String(year),
          start: new Date(opts.period.start).toISOString(),
          end: new Date(opts.period.end).toISOString(),
        }
      : {
          year,
          label: String(year),
          start: new Date(Date.UTC(year - 1, now.getUTCMonth(), now.getUTCDate())).toISOString(),
          end: now.toISOString(),
        };

  const playSec = 214 * 3600; // ~1w 4d
  const voiceMin = 1380; // 23h

  return {
    version: WRAPPED_PAYLOAD_VERSION,
    generatedAt: now.toISOString(),
    demo: true,
    period,
    user: { userId: 0, username, uuid: "demo-0000" },
    discordLinked: true,
    minemonitorAvailable: true,
    stats: {
      playtime: {
        value: playSec,
        rank: 12,
        total: 340,
        display: humanizeDuration(playSec),
        neighbors: board(12, 340, (r) => Math.round(playSec * (1 + (12 - r) * 0.08))),
      },
      sessions: { value: 96, rank: 18, total: 340 },
      avgSession: { value: Math.round(playSec / 96), display: humanizeDuration(Math.round(playSec / 96)) },
      tenure: { firstSeen: new Date(Date.UTC(year - 3, 4, 2)).toISOString(), days: 1130 },
      mostActiveDay: { date: `${year}-06-14`, seconds: 6 * 3600 + 40 * 60 },
      mostActiveMonth: { month: `${year}-06`, seconds: 61 * 3600 },

      minecraft: {
        sinceTracking: false,
        since: null,
        blocksMined: 128455,
        mobsKilled: 4210,
        distanceCm: 61_500_000, // 615 km
        breadCrafted: 312,
        fishCaught: 188,
        topBlock: { block: "minecraft:deepslate", count: 41230 },
      },
      topBlockBoard: {
        blockId: "minecraft:deepslate",
        rank: 3,
        total: 57,
        excludedNoBaseline: 4,
        rows: [
          { rank: 1, name: "DiggerDan", value: 90120, avatar: head("demo-b1"), you: false },
          { rank: 2, name: "CoalMiner_Kev", value: 62880, avatar: head("demo-b2"), you: false },
          { rank: 3, name: "You", value: 41230, avatar: null, you: true },
          { rank: 4, name: "QuietQuokka", value: 33990, avatar: head("demo-b4"), you: false },
          { rank: 5, name: "PixelPriya", value: 21400, avatar: head("demo-b5"), you: false },
        ],
      },

      shopPurchases: {
        value: 74,
        rank: 6,
        total: 120,
        totalSpent: 18450.5,
        topItem: { itemId: "minecraft:oak_planks", count: 22 },
        topOwner: { uuid: "demo-owner", name: "MelodyMiner", count: 19 },
        since: null,
        sinceTracking: false,
        neighbors: board(6, 120, (r) => 74 + (6 - r) * 6),
      },

      discordMessages: {
        value: 2894,
        rank: 14,
        total: 2712,
        neighbors: board(14, 2712, (r) => 2894 + (14 - r) * 120),
      },
      discordReactions: { value: 1207, rank: 22, total: 2712 },
      voiceMinutes: {
        value: voiceMin,
        rank: 9,
        total: 2712,
        display: humanizeDuration(voiceMin * 60),
        channelName: "General VC",
        neighbors: board(9, 2712, (r) => voiceMin + (9 - r) * 45),
      },
      reputation: {
        value: 3120,
        level: 12,
        lifetime: 3120,
        rank: 41,
        total: 1030,
        neighbors: board(41, 1030, (r) => 3120 + (41 - r) * 25),
      },
      topCommand: { command: "spawn", count: 214 },
      friend: { name: "Zephyr", minutes: 640 },
      ingameFriend: { name: "The_Aussie_BFG", minutes: 915 },
    },
    yoy: {
      priorYear: period.year - 1,
      playtimePct: 18.4,
      sessionsPct: -6.2,
      messagesPct: 42.9,
      voicePct: 11.1,
      shopPct: 63.0,
    },
    vibe: {
      label: "Chatty Grinder",
      blurb: "You put in the hours and never stopped talking about it.",
    },
  };
}
