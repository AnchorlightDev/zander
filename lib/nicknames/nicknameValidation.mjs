/**
 * Pure, dependency-free nickname validation.
 *
 * This module knows nothing about the database, LuckPerms, Discord or the web
 * app. It provides the primitives every surface (web form, API, plugin-facing
 * service) shares so the rules are enforced in exactly one place:
 *   - format (length + character whitelist, which also blocks formatting codes,
 *     Cyrillic / lookalike scripts and zero-width characters by construction),
 *   - blocked-word and rank-word matching against a normalised form,
 *   - the normalised "skeleton" used for impersonation checks,
 *   - Levenshtein edit distance (for the edit-distance-1 staff check),
 *   - the fixed colour palette.
 *
 * The database-backed impersonation checks (comparing a skeleton against other
 * players' usernames, live/reserved nicknames and staff names) live in the
 * service layer, which calls buildSkeleton()/withinEditDistance() from here.
 */

export const NICKNAME_MIN_LENGTH = 3;
export const NICKNAME_MAX_LENGTH = 16;

/** Stored value: ASCII letters, digits and underscore only. */
export const NICKNAME_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Fixed colour palette. `key` doubles as the MiniMessage / legacy colour name
 * the Velocity plugin renders with (`<red>`), and `hex` is for the web. Players
 * never supply raw codes; they pick one of these keys.
 */
export const NICKNAME_COLORS = [
  { key: "red", label: "Red", hex: "#FF5555" },
  { key: "gold", label: "Gold", hex: "#FFAA00" },
  { key: "yellow", label: "Yellow", hex: "#FFFF55" },
  { key: "green", label: "Green", hex: "#55FF55" },
  { key: "dark_green", label: "Dark Green", hex: "#00AA00" },
  { key: "aqua", label: "Aqua", hex: "#55FFFF" },
  { key: "dark_aqua", label: "Dark Aqua", hex: "#00AAAA" },
  { key: "blue", label: "Blue", hex: "#5555FF" },
  { key: "dark_blue", label: "Dark Blue", hex: "#0000AA" },
  { key: "light_purple", label: "Pink", hex: "#FF55FF" },
  { key: "dark_purple", label: "Purple", hex: "#AA00AA" },
  { key: "gray", label: "Gray", hex: "#AAAAAA" },
  { key: "white", label: "White", hex: "#FFFFFF" },
];

export const NICKNAME_COLOR_KEYS = new Set(NICKNAME_COLORS.map((c) => c.key));

/**
 * Default rank / authority words. The live list is stored in the editable
 * `nicknameBlocklist` table (seeded from this in migration 0081); this export
 * exists for seeding and tests, not as the runtime source of truth.
 */
export const DEFAULT_RANK_WORDS = [
  "admin", "administrator", "mod", "moderator", "owner", "staff", "helper",
  "dev", "developer", "support", "server", "console", "system", "official",
];

/** Human-facing messages. Deliberately generic: never reveal other players'
 *  names or the blocklist contents. */
export const NICKNAME_ERROR_MESSAGES = {
  empty: "Please enter a nickname.",
  not_string: "Please enter a nickname.",
  too_short: `Nicknames must be at least ${NICKNAME_MIN_LENGTH} characters.`,
  too_long: `Nicknames can be at most ${NICKNAME_MAX_LENGTH} characters.`,
  invalid_characters: "Nicknames can only contain letters, numbers and underscores.",
  blocked_word: "That nickname contains a word that isn't allowed.",
  rank_word: "That nickname is too similar to a staff or system name.",
  impersonates_player: "That nickname is too similar to another player's name.",
  reserved: "That nickname is too similar to another player's name.",
  invalid_color: "That isn't an available nickname colour.",
};

export function messageForCode(code) {
  return NICKNAME_ERROR_MESSAGES[code] || "That nickname isn't allowed.";
}

/**
 * Lightweight normalisation for word matching: lowercase and drop anything that
 * is not a-z / 0-9 (so underscores and stray punctuation can't hide a word).
 */
export function normalise(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const MULTI_FOLDS = [
  ["rn", "m"],
  ["vv", "w"],
];

const SINGLE_FOLDS = {
  "0": "o",
  "1": "l",
  "i": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
};

/**
 * Build the normalised skeleton used for impersonation checks:
 * lowercase, fold multi-character lookalikes (rn->m, vv->w), fold single
 * lookalikes (0->o, 1->l, i->l, 3->e, 4->a, 5->s, 7->t, 8->b), then strip
 * underscores and any remaining non-alphanumerics.
 *
 * Folding both a candidate and a target before comparing collapses leetspoofs:
 * "sh1t" and "shit" both skeletonise to "shlt".
 */
export function buildSkeleton(name) {
  let s = String(name == null ? "" : name).toLowerCase();
  for (const [from, to] of MULTI_FOLDS) {
    s = s.split(from).join(to);
  }
  let out = "";
  for (const ch of s) {
    if (ch === "_") continue;
    const folded = SINGLE_FOLDS[ch] ?? ch;
    if (/[a-z0-9]/.test(folded)) out += folded;
  }
  return out;
}

/** Levenshtein edit distance between two strings. */
export function editDistance(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * True when edit distance between a and b is <= max. Short-circuits when the
 * length difference alone already exceeds max.
 */
export function withinEditDistance(a, b, max) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  if (Math.abs(a.length - b.length) > max) return false;
  return editDistance(a, b) <= max;
}

/**
 * True when any word in `words` appears in `name`, tested against both the
 * plain normalised form and the folded skeleton (so leetspeak is caught).
 */
export function matchesAnyWord(name, words) {
  if (!Array.isArray(words) || words.length === 0) return false;
  const normalised = normalise(name);
  const skeleton = buildSkeleton(name);
  for (const raw of words) {
    const w = String(raw == null ? "" : raw).trim();
    if (!w) continue;
    const wn = normalise(w);
    if (wn && normalised.includes(wn)) return true;
    const ws = buildSkeleton(w);
    if (ws && skeleton.includes(ws)) return true;
  }
  return false;
}

/** Validate length + character whitelist. Returns { ok } or { ok:false, code }. */
export function validateFormat(name) {
  if (typeof name !== "string") return { ok: false, code: "not_string" };
  const value = name.trim();
  if (value.length === 0) return { ok: false, code: "empty" };
  if (value.length < NICKNAME_MIN_LENGTH) return { ok: false, code: "too_short" };
  if (value.length > NICKNAME_MAX_LENGTH) return { ok: false, code: "too_long" };
  if (!NICKNAME_PATTERN.test(value)) return { ok: false, code: "invalid_characters" };
  return { ok: true, value };
}

/**
 * Validate a colour choice. Empty / null is allowed (plain nickname) unless
 * `required` is set. A non-empty value must be a palette key.
 */
export function validateColor(color, { required = false } = {}) {
  if (color == null || color === "") {
    return required ? { ok: false, code: "invalid_color" } : { ok: true, value: null };
  }
  const key = String(color).trim().toLowerCase();
  if (!NICKNAME_COLOR_KEYS.has(key)) return { ok: false, code: "invalid_color" };
  return { ok: true, value: key };
}

/**
 * Full content validation (everything that needs no database): format,
 * rank-word and blocked-word checks, and colour. Returns the cleaned value,
 * its skeleton and normalised form so the caller can run the DB-backed
 * impersonation checks without recomputing.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string|null} [args.color]
 * @param {string[]} [args.rankWords]
 * @param {string[]} [args.bannedWords]
 * @param {boolean} [args.colorRequired]
 */
export function validateNicknameContent({
  name,
  color = null,
  rankWords = DEFAULT_RANK_WORDS,
  bannedWords = [],
  colorRequired = false,
} = {}) {
  const format = validateFormat(name);
  if (!format.ok) return { ok: false, code: format.code, message: messageForCode(format.code) };

  const value = format.value;
  if (matchesAnyWord(value, rankWords)) {
    return { ok: false, code: "rank_word", message: messageForCode("rank_word") };
  }
  if (matchesAnyWord(value, bannedWords)) {
    return { ok: false, code: "blocked_word", message: messageForCode("blocked_word") };
  }

  const col = validateColor(color, { required: colorRequired });
  if (!col.ok) return { ok: false, code: col.code, message: messageForCode(col.code) };

  return {
    ok: true,
    value,
    color: col.value,
    skeleton: buildSkeleton(value),
    normalised: normalise(value),
  };
}
