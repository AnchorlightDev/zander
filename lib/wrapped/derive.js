/**
 * Pure derivation helpers for Wrapped — ranking, year-over-year deltas,
 * humanised durations, and the closing "vibe" label. No DB or network here
 * so this stays unit-testable and tunable.
 */

/**
 * 1-indexed rank of `userId` within `entries` (higher value = better rank).
 * @param {Array<{ userId: number, value: number }>} entries
 * @param {number} userId
 * @returns {{ rank: number, total: number } | null}
 */
export function rankOf(entries, userId) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const idx = sorted.findIndex((e) => Number(e.userId) === Number(userId));
  if (idx === -1) return null;
  return { rank: idx + 1, total: sorted.length };
}

/**
 * The ranked slice of players immediately around `userId` — a Spotify-Wrapped
 * "leaderboard neighbourhood" (e.g. 2 above, 2 below). Pure so it's testable.
 *
 * @param {Array<{ userId: number, value: number }>} entries
 * @param {number} userId
 * @param {Record<string|number, string> | Map<number, string>} [nameById]
 * @param {number} [span=2]  how many rows to show on each side
 * @returns {{ rank: number, total: number, rows: Array<{ rank: number, name: string, value: number, you: boolean }> } | null}
 */
export function neighborhood(entries, userId, nameById, span = 2, avatarById) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const idx = sorted.findIndex((e) => Number(e.userId) === Number(userId));
  if (idx === -1) return null;

  const lookup = (map, id) => {
    if (!map) return undefined;
    if (typeof map.get === "function") return map.get(Number(id)) ?? map.get(String(id));
    return map[id] ?? map[String(id)];
  };
  const nameOf = (id) => lookup(nameById, id) ?? "Someone";
  const avatarOf = (id) => lookup(avatarById, id) ?? null;

  const lo = Math.max(0, idx - span);
  const hi = Math.min(sorted.length - 1, idx + span);
  const rows = [];
  for (let i = lo; i <= hi; i++) {
    const you = i === idx;
    rows.push({
      rank: i + 1,
      name: you ? "You" : nameOf(sorted[i].userId),
      value: sorted[i].value,
      avatar: avatarOf(sorted[i].userId),
      you,
    });
  }
  return { rank: idx + 1, total: sorted.length, rows };
}

/**
 * Percent change from `prior` → `current`. Null when there's no usable
 * baseline (missing prior run, or prior value of 0).
 */
export function pctChange(current, prior) {
  if (prior === null || prior === undefined || !Number.isFinite(prior) || prior === 0) return null;
  if (current === null || current === undefined || !Number.isFinite(current)) return null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

/**
 * Durations everywhere in Wrapped read in month / day / hour terms (with
 * minutes/seconds only for short spans): e.g. 144000s → "1d 16h", not "40h".
 * Shows the largest two non-zero units — three when months are involved.
 * A month is treated as 30 days.
 */
export function humanizeDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return "no time at all";
  if (s < 60) return `${s}s`;

  const MIN = 60, HOUR = 3600, DAY = 86400, MONTH = 30 * DAY;
  const mo = Math.floor(s / MONTH);
  const d = Math.floor((s % MONTH) / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  const m = Math.floor((s % HOUR) / MIN);

  const parts = [];
  if (mo) parts.push(`${mo}mo`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);

  return parts.slice(0, mo ? 3 : 2).join(" ") || `${m}m`;
}

/**
 * Rule-based personality label from the computed stats. Deliberately simple
 * threshold logic — tweak the numbers here, not a model.
 *
 * @param {{
 *   playtimeSeconds: number,
 *   discordMessages: number,
 *   voiceMinutes: number,
 *   sessions: number,
 *   topCommand: string | null,
 *   nightSessionRatio?: number
 * }} s
 */
export function vibeLabel(s) {
  const hours = (s.playtimeSeconds || 0) / 3600;
  const msgs = s.discordMessages || 0;
  const voice = s.voiceMinutes || 0;
  const sessions = s.sessions || 0;

  const shopBuys = s.shopPurchases || 0;

  const chatty = msgs >= 500;
  const talker = voice >= 600; // 10h+ in voice
  const grinder = hours >= 100;
  const dabbler = hours < 10 && sessions < 10;
  const social = chatty || talker;
  const marketRegular = shopBuys >= 50 && hours < 40;

  let label;
  let blurb;

  if (marketRegular) {
    label = "Market Regular";
    blurb = "More time at the shop stalls than anywhere else on the map.";
  } else if (grinder && chatty) {
    label = "Chatty Grinder";
    blurb = "You put in the hours and never stopped talking about it.";
  } else if (grinder && talker) {
    label = "Voice-Chat Marathoner";
    blurb = "Hundreds of hours in-game, most of them with friends in your ear.";
  } else if (grinder) {
    label = "Quiet Grinder";
    blurb = "Head down, blocks placed, work done.";
  } else if (talker) {
    label = "Campfire Regular";
    blurb = "The voice channel wasn't the same without you.";
  } else if (chatty) {
    label = "Server Chatterbox";
    blurb = "If something happened, you had something to say about it.";
  } else if (social) {
    label = "Community Butterfly";
    blurb = "You showed up for the people as much as the game.";
  } else if (dabbler) {
    label = "Weekend Visitor";
    blurb = "You dropped by, said hi, and kept it light this year.";
  } else {
    label = "Steady Builder";
    blurb = "A reliable presence — a little bit of everything, all year long.";
  }

  return { label, blurb };
}
