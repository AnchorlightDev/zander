/**
 * lib/discord/guildMembers.mjs
 *
 * Shared, throttled full guild-member fetch.
 *
 * Several crons (rank role sync, booster rewards, unverified reminders) and the
 * LuckPerms audit each need the full member list. When each calls
 * guild.members.fetch() independently on its own schedule, they collide on
 * Discord's gateway opcode-8 (Request Guild Members) rate limit and fail with
 * "Request with opcode 8 was rate limited. Retry after N seconds", skipping
 * their runs.
 *
 * Funnelling every full fetch through here gives one throttle window plus
 * in-flight de-duplication per guild. The GuildMembers gateway events keep
 * guild.members.cache current between fetches, so reusing a recently fetched
 * cache is correct; on a rate-limit we fall back to that cache rather than
 * failing the caller.
 */

const lastOkFetchAt = new Map(); // guildId -> ms timestamp of last successful full fetch
const inFlight = new Map(); // guildId -> Promise<Collection>

/**
 * Ensure the guild's full member list is loaded, at most once per throttle
 * window across the whole process, de-duplicating concurrent callers. Returns
 * guild.members.cache (a discord.js Collection).
 *
 * @param {import("discord.js").Guild} guild
 * @param {{ maxAgeMs?: number, time?: number }} [opts]
 *   maxAgeMs — reuse the cache if a full fetch succeeded this recently (default 10 min).
 *   time     — per-fetch timeout handed to guild.members.fetch (default 120 s).
 */
export async function ensureGuildMembers(guild, { maxAgeMs = 10 * 60_000, time = 120_000 } = {}) {
  if (!guild) return null;
  const id = guild.id;

  // A recent successful fetch — the live member events have kept the cache fresh
  // since, so reuse it instead of paying for another opcode-8 request.
  if (Date.now() - (lastOkFetchAt.get(id) || 0) < maxAgeMs && guild.members.cache.size > 1) {
    return guild.members.cache;
  }

  // Coalesce concurrent callers onto a single in-flight fetch.
  if (!inFlight.has(id)) {
    const p = (async () => {
      try {
        await guild.members.fetch({ time });
        lastOkFetchAt.set(id, Date.now());
        return guild.members.cache;
      } finally {
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, p);
  }

  try {
    return await inFlight.get(id);
  } catch (error) {
    // Rate limited / timed out: fall back to the cache the live member events
    // keep current, rather than failing the caller's run. Only propagate when
    // there is genuinely nothing cached to work with.
    if (guild.members.cache.size > 1) return guild.members.cache;
    throw error;
  }
}
