/**
 * The Wrapped slide sequence, derived from a persisted payload.
 *
 * Pure and dependency-free so it runs the same in Node (server-rendered
 * per-slide share cards — lib/wrapped/slideCard.js) and in the browser (the
 * deck in views/wrapped/show.ejs). All display strings are fully formatted
 * here, so neither consumer needs its own copy of the number/date helpers.
 *
 * Each descriptor: { key, kind, mood, dur?, ... }
 *   kind "title" — opening slide (client draws logo + avatar itself)
 *   kind "stat"  — emoji, flavor, stat, optional sub + rank
 *   kind "board" — leaderboard-neighbourhood: title + neighbors{rows[]}
 *   kind "vibe"  — closing personality slide (client appends the share panel)
 */

import { humanizeDuration } from "./derive.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function num(n) {
  return n == null ? "0" : Number(n).toLocaleString("en-US");
}

// All Wrapped durations share one month/day/hour formatter (lib/wrapped/derive).
const fmtSecs = humanizeDuration;

function toDate(dateish) {
  if (!dateish) return null;
  const s = String(dateish);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T12:00:00Z" : s);
  return isNaN(d.getTime()) ? null : d;
}

function dmy(dateish) {
  const d = toDate(dateish);
  if (!d) return null;
  return `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function weekdayLabel(dateish) {
  const d = toDate(dateish);
  if (!d) return null;
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function monthLabel(ym) {
  const p = String(ym).split("-");
  if (p.length < 2) return String(ym);
  return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function plur(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

/** "minecraft:deepslate_diamond_ore" -> "Deepslate Diamond Ore" */
function prettyBlock(id) {
  return String(id || "")
    .replace(/^minecraft:/, "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "a mystery block";
}

/** Human "time on the server" — anchored to the period end, like every other stat. */
function sinceJoin(dateish, fallbackDays, periodEnd, now) {
  const d = new Date(dateish);
  const pEnd = periodEnd ? new Date(periodEnd).getTime() : Date.now();
  const nowMs = Math.min(now ?? Date.now(), pEnd || Date.now());
  const cur = new Date(nowMs);
  if (isNaN(d.getTime())) {
    const fd = Number(fallbackDays) || 0;
    return fd >= 1 ? plur(fd, "day") : "today";
  }
  let years = cur.getUTCFullYear() - d.getUTCFullYear();
  let months = cur.getUTCMonth() - d.getUTCMonth();
  const days = cur.getUTCDate() - d.getUTCDate();
  if (days < 0) months--;
  if (months < 0) { months += 12; years--; }
  if (years < 0) return "today";
  if (years >= 1) return plur(years, "year") + (months ? ", " + plur(months, "month") : "");
  if (months >= 1) return plur(months, "month");
  const totalDays = Math.max(0, Math.round((cur - d) / 86400000));
  return totalDays >= 1 ? plur(totalDays, "day") : "today";
}

function hasVal(block) {
  return block && Number(block.value) > 0;
}

function rankLine(block, unitPlural) {
  if (!block || block.rank == null || block.total == null) return null;
  if (block.value != null && Number(block.value) <= 0) return null;
  return `You're #${block.rank} of ${block.total} ${unitPlural || "players"}`;
}

function neighborsFor(block, valueKind) {
  const nb = block && block.neighbors;
  if (!nb || !nb.rows || nb.rows.length <= 1) return null;
  const fmt =
    valueKind === "secs" ? (v) => fmtSecs(v)
    : valueKind === "mins" ? (v) => fmtSecs((v || 0) * 60)
    : valueKind === "rep" ? (v) => `${num(v)} rep`
    : valueKind === "shops" ? (v) => `${num(v)} ${Number(v) === 1 ? "buy" : "buys"}`
    : valueKind === "blocks" ? (v) => num(v)
    : (v) => `${num(v)} msgs`;
  return {
    rank: nb.rank,
    total: nb.total,
    // rows already carry { rank, name, value, avatar, you }
    rows: nb.rows.map((r) => ({ ...r, displayValue: fmt(r.value) })),
  };
}

function yoyLine(v, priorYear) {
  if (v == null) return null;
  return `${v >= 0 ? "up " : "down "}${Math.abs(v)}% vs ${priorYear}`;
}

/**
 * @param {object} payload  a persisted Wrapped payload (wrappedRuns.payload)
 * @param {{ now?: number }} [opts]
 * @returns {Array<object>} slide descriptors, in order
 */
export function buildWrappedSlides(payload, opts = {}) {
  const P = payload || {};
  const s = P.stats || {};
  const now = opts.now ?? Date.now();
  const periodEnd = P.period && P.period.end;
  const periodLabel = (P.period && P.period.label) || "year";

  const slides = [];
  slides.push({ key: "intro", kind: "title", mood: "chime", dur: 3800 });

  if (hasVal(s.playtime)) {
    slides.push({
      key: "playtime", kind: "stat", mood: "rise", emoji: "⛏️",
      flavor: "You spent this much time with us",
      stat: s.playtime.display, rank: rankLine(s.playtime, "players"),
    });
    const nb = neighborsFor(s.playtime, "secs");
    if (nb) slides.push({
      key: "playtimeBoard", kind: "board", mood: "fanfare", dur: 6000,
      title: "Where you land on playtime", neighbors: nb,
    });
  }

  if (hasVal(s.sessions)) {
    slides.push({
      key: "sessions", kind: "stat", mood: "chime", emoji: "🚪",
      flavor: "That was spread across",
      stat: `${num(s.sessions.value)} sessions`,
      sub: s.avgSession && Number(s.avgSession.value) > 0
        ? `about ${s.avgSession.display} each` : null,
      rank: rankLine(s.sessions, "players"),
    });
  }

  if (s.tenure && s.tenure.firstSeen) {
    const joinedOn = dmy(s.tenure.firstSeen);
    slides.push({
      key: "tenure", kind: "stat", mood: "chime", emoji: "🌱",
      flavor: "You've been part of the server for",
      stat: sinceJoin(s.tenure.firstSeen, s.tenure.days, periodEnd, now),
      sub: joinedOn ? `since ${joinedOn}` : null,
    });
  }

  if (s.mostActiveDay && weekdayLabel(s.mostActiveDay.date)) {
    slides.push({
      key: "mostActiveDay", kind: "stat", mood: "pop", emoji: "🔥",
      flavor: "Your busiest day was",
      stat: weekdayLabel(s.mostActiveDay.date),
      sub: `${fmtSecs(s.mostActiveDay.seconds)} played`,
    });
  }

  if (s.mostActiveMonth) {
    slides.push({
      key: "mostActiveMonth", kind: "stat", mood: "pop", emoji: "📅",
      flavor: "Your biggest month was",
      stat: monthLabel(s.mostActiveMonth.month),
      sub: `${fmtSecs(s.mostActiveMonth.seconds)} played`,
    });
  }

  // ── Vanilla Minecraft stats (MineMonitor snapshot diff) ──
  const mc = s.minecraft;
  if (mc) {
    const trackNote = mc.sinceTracking ? "since we started counting" : null;
    if (mc.blocksMined > 0) {
      slides.push({
        key: "blocksMined", kind: "stat", mood: "rise", emoji: "⛏️",
        flavor: "You broke", stat: `${num(mc.blocksMined)} blocks`, sub: trackNote,
      });
    }
    if (mc.topBlock && mc.topBlock.count > 0) {
      slides.push({
        key: "topBlock", kind: "stat", mood: "chime", emoji: "🧱",
        flavor: "Your pickaxe's favourite",
        stat: prettyBlock(mc.topBlock.block),
        sub: `${num(mc.topBlock.count)} of them` + (trackNote ? ` · ${trackNote}` : ""),
      });

      // Paired board: the top miners of that same block.
      const b = s.topBlockBoard;
      if (b && b.rows && b.rows.length) {
        slides.push({
          key: "topBlockBoard", kind: "board", mood: "fanfare", dur: 6000,
          title: `Who else was chasing ${prettyBlock(mc.topBlock.block)}`,
          neighbors: {
            rank: b.rank ?? null,
            total: b.total ?? null,
            rows: b.rows.map((r) => ({ ...r, displayValue: num(r.value) })),
          },
        });
      }
    }
    if (mc.mobsKilled > 0) {
      slides.push({
        key: "mobsKilled", kind: "stat", mood: "fanfare", emoji: "⚔️",
        flavor: "You defeated", stat: `${num(mc.mobsKilled)} mobs`, sub: trackNote,
      });
    }
    if (mc.distanceCm > 0) {
      const km = mc.distanceCm / 100000;
      slides.push({
        key: "distance", kind: "stat", mood: "rise", emoji: "🧭",
        flavor: "You travelled",
        stat: `${km >= 100 ? Math.round(km) : Math.round(km * 10) / 10} km`,
        sub: `about ${num(Math.round(mc.distanceCm / 100))} blocks` + (trackNote ? ` · ${trackNote}` : ""),
      });
    }
    if (mc.breadCrafted > 0) {
      slides.push({
        key: "bread", kind: "stat", mood: "chime", emoji: "🍞",
        flavor: "You baked", stat: `${num(mc.breadCrafted)} loaves of bread`, sub: trackNote,
      });
    }
    if (mc.fishCaught > 0) {
      slides.push({
        key: "fish", kind: "stat", mood: "chime", emoji: "🎣",
        flavor: "You reeled in", stat: `${num(mc.fishCaught)} fish`, sub: trackNote,
      });
    }
  }

  if (hasVal(s.discordMessages)) {
    slides.push({
      key: "discordMessages", kind: "stat", mood: "pop", emoji: "💬",
      flavor: "Over in Discord you sent",
      stat: `${num(s.discordMessages.value)} messages`,
      rank: rankLine(s.discordMessages, "chatters"),
    });
    const nb = neighborsFor(s.discordMessages, "msgs");
    if (nb) slides.push({
      key: "messagesBoard", kind: "board", mood: "fanfare", dur: 6000,
      title: "Where you land on chat", neighbors: nb,
    });
  }

  if (hasVal(s.discordReactions)) {
    slides.push({
      key: "discordReactions", kind: "stat", mood: "pop", emoji: "👍",
      flavor: "And you reacted",
      stat: `${num(s.discordReactions.value)} times`,
      rank: rankLine(s.discordReactions, "members"),
    });
  }

  if (hasVal(s.voiceMinutes)) {
    slides.push({
      key: "voiceMinutes", kind: "stat", mood: "rise", emoji: "🎙️",
      flavor: "You spent",
      stat: `${s.voiceMinutes.display} in voice`,
      sub: s.voiceMinutes.channelName ? `most of it in ${s.voiceMinutes.channelName}` : null,
      rank: rankLine(s.voiceMinutes, "members"),
    });
    const nb = neighborsFor(s.voiceMinutes, "mins");
    if (nb) slides.push({
      key: "voiceBoard", kind: "board", mood: "fanfare", dur: 6000,
      title: "Where you land on voice time", neighbors: nb,
    });
  }

  if (s.reputation) {
    slides.push({
      key: "reputation", kind: "stat", mood: "fanfare", emoji: "⭐",
      flavor: "Your reputation reached",
      stat: `Level ${s.reputation.level}`,
      sub: `${num(s.reputation.lifetime)} lifetime reputation`,
      rank: rankLine(s.reputation, "members"),
    });
    const nb = neighborsFor(s.reputation, "rep");
    if (nb) slides.push({
      key: "reputationBoard", kind: "board", mood: "fanfare", dur: 6000,
      title: "Where you land on reputation", neighbors: nb,
    });
  }

  // ── Player-shop purchases ──
  if (hasVal(s.shopPurchases)) {
    const sp = s.shopPurchases;
    const trackNote = sp.sinceTracking
      ? `since we started counting${sp.since ? ` in ${monthLabel(String(sp.since).slice(0, 7))}` : ""}`
      : null;
    slides.push({
      key: "shopPurchases", kind: "stat", mood: "pop", emoji: "🪧",
      flavor: "At the player shops you made",
      stat: `${num(sp.value)} purchases`,
      sub: sp.topItem && sp.topItem.itemId
        ? `mostly ${prettyBlock(sp.topItem.itemId)}${trackNote ? ` · ${trackNote}` : ""}`
        : trackNote,
      rank: rankLine(sp, "shoppers"),
    });

    if (sp.topOwner && sp.topOwner.name) {
      slides.push({
        key: "shopOwner", kind: "stat", mood: "chime", emoji: "🤝",
        flavor: "Your favourite shopkeeper",
        stat: sp.topOwner.name,
        sub: `${num(sp.topOwner.count)} ${Number(sp.topOwner.count) === 1 ? "buy" : "buys"} from their shop`,
      });
    }

    const nb = neighborsFor(sp, "shops");
    if (nb) slides.push({
      key: "shopBoard", kind: "board", mood: "fanfare", dur: 6000,
      title: "Where you land on shopping", neighbors: nb,
    });
  }

  if (s.topCommand) {
    slides.push({
      key: "topCommand", kind: "stat", mood: "chime", emoji: "⌨️",
      flavor: "Your most-used command",
      stat: s.topCommand.command,
      sub: `run ${num(s.topCommand.count)} times`,
    });
  }

  if (s.friend) {
    slides.push({
      key: "friend", kind: "stat", mood: "chime", emoji: "🤝",
      flavor: `You and ${s.friend.name}`,
      stat: `${humanizeDuration((s.friend.minutes || 0) * 60)} in voice together`,
      sub: "your top voice companion this year",
    });
  }

  if (s.ingameFriend) {
    slides.push({
      key: "ingameFriend", kind: "stat", mood: "chime", emoji: "🧭",
      flavor: `In-game, you crossed paths most with ${s.ingameFriend.name}`,
      stat: `${humanizeDuration((s.ingameFriend.minutes || 0) * 60)} online together`,
      sub: "your top in-game companion this year",
    });
  }

  if (P.yoy) {
    const yy = [
      yoyLine(P.yoy.playtimePct, P.yoy.priorYear) && `playtime ${yoyLine(P.yoy.playtimePct, P.yoy.priorYear)}`,
      yoyLine(P.yoy.messagesPct, P.yoy.priorYear) && `messages ${yoyLine(P.yoy.messagesPct, P.yoy.priorYear)}`,
      yoyLine(P.yoy.voicePct, P.yoy.priorYear) && `voice ${yoyLine(P.yoy.voicePct, P.yoy.priorYear)}`,
    ].filter(Boolean);
    if (yy.length) {
      slides.push({
        key: "yoy", kind: "stat", mood: "pop", emoji: "📈",
        flavor: "Compared to last year",
        stat: yy[0].charAt(0).toUpperCase() + yy[0].slice(1),
        sub: yy.slice(1).join(" · ") || null,
      });
    }
  }

  if (slides.length === 1) {
    slides.push({
      key: "empty", kind: "stat", mood: "chime", emoji: "🌌",
      flavor: "Your story is still being written",
      stat: "Check back soon",
      sub: `We don't have enough activity logged for ${periodLabel} yet.`,
    });
  }

  slides.push({
    key: "vibe", kind: "vibe", mood: "drum", emoji: "🎭",
    flavor: "This year, you were a",
    label: (P.vibe && P.vibe.label) || "Steady Builder",
    blurb: (P.vibe && P.vibe.blurb) || "",
  });

  return slides;
}
