/**
 * lib/discordIds.mjs
 *
 * Parsing and tidying lists of Discord snowflake IDs.
 *
 * Imports nothing, so the parsing is unit-testable without a Discord client.
 * Used for the per-form list of people to DM when a submission lands, where
 * the value is typed into a dashboard textarea by hand and so arrives in
 * whatever shape the admin felt like.
 */

/** Discord snowflakes are 17-20 digits today; the range leaves room to grow. */
const SNOWFLAKE = /^\d{17,20}$/;

/** A single ID, or null when it is not a plausible snowflake. */
export function parseDiscordId(raw) {
  // Tolerates a pasted mention (<@123>) or a stray angle bracket, because that
  // is what you get when someone copies out of Discord rather than using
  // "Copy User ID".
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/^<@!?/, "")
    .replace(/>$/, "");

  return SNOWFLAKE.test(cleaned) ? cleaned : null;
}

/**
 * Parse a comma / newline / space separated list into unique snowflakes.
 *
 * Accepts the stored JSON array as well, so a value can be read back out of
 * the column and fed straight in again. Anything unparseable is dropped rather
 * than rejected: one fat-fingered id should not stop the other four people
 * being notified.
 */
export function parseDiscordIds(raw, { limit = 25 } = {}) {
  let list = raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        list = trimmed.split(/[\s,]+/);
      }
    } else {
      list = trimmed.split(/[\s,]+/);
    }
  }

  if (!Array.isArray(list)) list = list === undefined || list === null ? [] : [list];

  const seen = new Set();
  for (const entry of list) {
    const id = parseDiscordId(entry);
    if (id) seen.add(id);
    if (seen.size >= limit) break;
  }

  return [...seen];
}

/** The stored list as the editor's textarea shows it: one per line. */
export function formatDiscordIds(raw) {
  return parseDiscordIds(raw).join("\n");
}
