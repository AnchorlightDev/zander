import { createRequire } from "module";

const require = createRequire(import.meta.url);

/**
 * Thin client for MineMonitor's read-only Wrapped stats endpoint
 * (`GET /api/wrapped/stats/:uuid?start=&end=`).
 *
 * Config (either source works for the base URL):
 *   - .env        → `MINEMONITOR_BASE_URL`           (preferred)
 *   - config.json → `wrapped.minemonitor.baseUrl`
 *   - .env        → `MINEMONITOR_CONNECTION_TOKEN`   (a MineMonitor "Connections"
 *                                                     token with the `wrapped.read` scope)
 *
 * The endpoint is token-only and internal. If it's unreachable or
 * misconfigured we degrade gracefully: callers get `null` and the Wrapped
 * payload is built from Zander data alone (Discord slides omitted).
 */

let _warnedMissing = false;

function getConfig() {
  let baseUrl =
    process.env.MINEMONITOR_BASE_URL || process.env.MINEMONITOR_URL || null;
  let dateFormat = process.env.MINEMONITOR_DATE_FORMAT || "date"; // date | iso | epoch | epochms
  try {
    const config = require("../../config.json");
    baseUrl = baseUrl || config?.wrapped?.minemonitor?.baseUrl || null;
    if (!process.env.MINEMONITOR_DATE_FORMAT) {
      dateFormat = config?.wrapped?.minemonitor?.dateFormat ?? dateFormat;
    }
  } catch {
    /* config.json absent */
  }
  const token =
    process.env.MINEMONITOR_CONNECTION_TOKEN || process.env.MINEMONITOR_API_KEY || null;
  return { baseUrl: baseUrl ? String(baseUrl).trim() : null, token, dateFormat };
}

/** Render a Date for the MineMonitor query in the configured format. */
function fmtDate(d, format) {
  switch (format) {
    case "iso": return d.toISOString();
    case "epoch": return String(Math.floor(d.getTime() / 1000));
    case "epochms": return String(d.getTime());
    case "date":
    default: return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
}

export function isMineMonitorConfigured() {
  const { baseUrl, token } = getConfig();
  return Boolean(baseUrl && token);
}

/**
 * @param {string} uuid  dashed Minecraft UUID
 * @param {Date} start
 * @param {Date} end
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<null | {
 *   uuid: string,
 *   discordLinked: boolean,
 *   discordMessages: number,
 *   discordReactions: number,
 *   voiceSeconds: number,
 *   reputationLevel: number | null,
 *   lifetimeReputation: number | null,
 *   topCommand: { command: string, count: number } | null,
 *   topVoiceCompanion: { discordUserId: string, displayName: string | null, seconds: number } | null
 * }>}
 */
export async function fetchWrappedStats(uuid, start, end, opts = {}) {
  const { baseUrl, token, dateFormat } = getConfig();
  if (!baseUrl || !token) {
    if (!_warnedMissing) {
      _warnedMissing = true;
      console.warn(
        `[WRAPPED] MineMonitor not configured — Discord/voice slides disabled. ` +
        `missing: ${[!baseUrl && "baseUrl (MINEMONITOR_BASE_URL / config.wrapped.minemonitor.baseUrl)", !token && "token (MINEMONITOR_CONNECTION_TOKEN)"].filter(Boolean).join(", ")}`
      );
    }
    return null;
  }
  if (!uuid) return null;

  const url =
    `${baseUrl.replace(/\/+$/, "")}/api/wrapped/stats/${encodeURIComponent(uuid)}` +
    `?start=${encodeURIComponent(fmtDate(start, dateFormat))}` +
    `&end=${encodeURIComponent(fmtDate(end, dateFormat))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[WRAPPED] MineMonitor stats ${res.status} for ${uuid}`);
      return null;
    }

    const raw = await res.json();
    if (!raw || raw.ok === false || raw.success === false) {
      console.warn(`[WRAPPED] MineMonitor stats error body for ${uuid}:`, raw?.error || raw?.message);
      return null;
    }
    // Tolerate {..fields}, {data:{..}}, {stats:{..}} and camel/snake_case.
    const b = raw.data && typeof raw.data === "object" ? raw.data
      : raw.stats && typeof raw.stats === "object" ? raw.stats
      : raw;
    const pick = (...keys) => {
      for (const k of keys) if (b[k] !== undefined && b[k] !== null) return b[k];
      return undefined;
    };

    const parsed = {
      uuid: pick("uuid", "player_uuid", "playerUuid") ?? uuid,
      discordLinked: Boolean(pick("discordLinked", "discord_linked", "linked")),
      discordMessages: Number(pick("discordMessages", "discord_messages", "messages")) || 0,
      discordReactions: Number(pick("discordReactions", "discord_reactions", "reactions")) || 0,
      voiceSeconds:
        Number(pick("voiceSeconds", "voice_seconds")) ||
        Number(pick("voiceMinutes", "voice_minutes")) * 60 ||
        0,
      reputationLevel: pick("reputationLevel", "reputation_level", "repLevel") ?? null,
      lifetimeReputation: pick("lifetimeReputation", "lifetime_reputation", "reputation", "rep") ?? null,
      topCommand: pick("topCommand", "top_command") ?? null,
      topVoiceCompanion: pick("topVoiceCompanion", "top_voice_companion") ?? null,
      topVoiceChannel: pick("topVoiceChannel", "top_voice_channel") ?? null,
      minecraftStats: pick("minecraftStats", "minecraft_stats", "mcStats") ?? null,
      shopStats: pick("shopStats", "shop_stats") ?? null,
    };

    console.info(
      `[WRAPPED] MineMonitor ${uuid}: linked=${parsed.discordLinked} msgs=${parsed.discordMessages} ` +
      `reacts=${parsed.discordReactions} voiceSec=${parsed.voiceSeconds} rep=${parsed.reputationLevel}`
    );
    return parsed;
  } catch (err) {
    console.warn(`[WRAPPED] MineMonitor stats fetch failed for ${uuid}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full ranked list for one MineMonitor-owned stat over the period
 * (`GET /api/wrapped/leaderboard/:stat`). One call replaces a per-user fan-out
 * of `/stats` requests when building the leaderboard cache.
 *
 * @param {"messages"|"reactions"|"voiceSeconds"|"reputation"} stat
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<null | Array<{ discordUserId: string, displayName: string|null, value: number, rank: number }>>}
 */
export async function fetchWrappedLeaderboard(stat, start, end, opts = {}) {
  const { baseUrl, token, dateFormat } = getConfig();
  if (!baseUrl || !token) return null;

  const url =
    `${baseUrl.replace(/\/+$/, "")}/api/wrapped/leaderboard/${encodeURIComponent(stat)}` +
    `?start=${encodeURIComponent(fmtDate(start, dateFormat))}` +
    `&end=${encodeURIComponent(fmtDate(end, dateFormat))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[WRAPPED] MineMonitor leaderboard ${stat} ${res.status}`);
      return null;
    }
    const raw = await res.json();
    if (!raw || raw.ok === false) return null;
    const list = Array.isArray(raw.leaderboard) ? raw.leaderboard : Array.isArray(raw) ? raw : [];
    return list
      .map((e) => ({
        discordUserId: String(e.discordUserId ?? e.discord_user_id ?? e.userId ?? ""),
        minecraftUuid: e.minecraftUuid ?? e.minecraft_uuid ?? null,
        displayName: e.displayName ?? e.display_name ?? null,
        value: Number(e.value ?? 0) || 0,
        rank: Number(e.rank ?? 0) || 0,
      }))
      .filter((e) => e.discordUserId || e.minecraftUuid);
  } catch (err) {
    console.warn(`[WRAPPED] MineMonitor leaderboard ${stat} fetch failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Top miners of one block for the period (MineMonitor
 * `GET /api/wrapped/block-leaderboard/:blockId`). Same null-on-any-failure
 * contract as its siblings.
 *
 * @param {string} blockId e.g. "minecraft:deepslate"
 * @returns {Promise<null | { blockId: string, total: number, excludedNoBaseline: number,
 *   rows: Array<{ rank: number, uuid: string, name: string|null, value: number }> }>}
 */
export async function fetchBlockLeaderboard(blockId, start, end, opts = {}) {
  const { baseUrl, token, dateFormat } = getConfig();
  if (!baseUrl || !token || !blockId) return null;

  const url =
    `${baseUrl.replace(/\/+$/, "")}/api/wrapped/block-leaderboard/${encodeURIComponent(blockId)}` +
    `?start=${encodeURIComponent(fmtDate(start, dateFormat))}` +
    `&end=${encodeURIComponent(fmtDate(end, dateFormat))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[WRAPPED] MineMonitor block-leaderboard ${blockId} ${res.status}`);
      return null;
    }
    const raw = await res.json();
    if (!raw || raw.ok === false) return null;
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    return {
      blockId: raw.blockId || blockId,
      total: Number(raw.total) || 0,
      excludedNoBaseline: Number(raw.excludedNoBaseline) || 0,
      rows: rows.map((r) => ({
        rank: Number(r.rank) || 0,
        uuid: r.uuid || null,
        name: r.name ?? null,
        value: Number(r.value) || 0,
      })),
    };
  } catch (err) {
    console.warn(`[WRAPPED] MineMonitor block-leaderboard ${blockId} fetch failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * In-game "gaming buddies" for a Minecraft UUID — top players by shared
 * session-overlap time in the period (MineMonitor
 * `GET /api/wrapped/buddies/ingame/:uuid`). Degrades to `null` exactly like
 * `fetchWrappedStats`.
 *
 * @param {string} uuid
 * @param {Date} start
 * @param {Date} end
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<null | Array<{ uuid: string, name: string | null, seconds: number }>>}
 */
export async function fetchWrappedBuddiesIngame(uuid, start, end, opts = {}) {
  const { baseUrl, token, dateFormat } = getConfig();
  if (!baseUrl || !token || !uuid) return null;

  const url =
    `${baseUrl.replace(/\/+$/, "")}/api/wrapped/buddies/ingame/${encodeURIComponent(uuid)}` +
    `?start=${encodeURIComponent(fmtDate(start, dateFormat))}` +
    `&end=${encodeURIComponent(fmtDate(end, dateFormat))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[WRAPPED] MineMonitor ingame buddies ${res.status} for ${uuid}`);
      return null;
    }
    const raw = await res.json();
    if (!raw || raw.ok === false) return null;
    const list = Array.isArray(raw.buddies) ? raw.buddies : Array.isArray(raw) ? raw : [];
    return list
      .map((b) => ({
        uuid: b.uuid ?? b.player_uuid ?? null,
        name: b.name ?? b.displayName ?? null,
        seconds: Number(b.seconds ?? b.overlapSeconds ?? 0) || 0,
      }))
      .filter((b) => b.seconds > 0);
  } catch (err) {
    console.warn(`[WRAPPED] MineMonitor ingame buddies fetch failed for ${uuid}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verbose one-shot probe for the admin dashboard — never swallows anything.
 * @returns {Promise<{ configured: boolean, missing: string[], url: string|null,
 *   status: number|null, ok: boolean, rawBody: string|null, parsed: object|null,
 *   error: string|null }>}
 */
export async function diagnoseMineMonitor(uuid, start, end) {
  const { baseUrl, token, dateFormat } = getConfig();
  const missing = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!token) missing.push("token");
  const out = {
    configured: missing.length === 0,
    missing,
    url: null,
    status: null,
    ok: false,
    rawBody: null,
    parsed: null,
    error: null,
  };
  if (!out.configured || !uuid) {
    if (!uuid) out.error = "no uuid for that user (Minecraft account not linked?)";
    return out;
  }

  out.url =
    `${baseUrl.replace(/\/+$/, "")}/api/wrapped/stats/${encodeURIComponent(uuid)}` +
    `?start=${encodeURIComponent(fmtDate(start, dateFormat))}` +
    `&end=${encodeURIComponent(fmtDate(end, dateFormat))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(out.url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    out.status = res.status;
    out.ok = res.ok;
    out.rawBody = (await res.text()).slice(0, 4000);
    out.parsed = await fetchWrappedStats(uuid, start, end).catch(() => null);
  } catch (err) {
    out.error = err.message;
  } finally {
    clearTimeout(timer);
  }
  return out;
}
