/**
 * lib/formRequirements.mjs
 *
 * Eligibility rules for a form: given a set of thresholds and a set of measured
 * values, decide whether someone may fill the form in, and say exactly why not
 * when they may not.
 *
 * Imports nothing, on purpose. Every value this compares is handed in by
 * services/formRequirementsService.js, which does the querying -- so the rules
 * themselves can be exercised against fabricated numbers without a database,
 * a LiteBans instance or a Discord client (same reasoning as lib/apiKeys.js
 * and lib/formFields.js).
 *
 * Failure messages quote the real numbers on both sides ("You need 20 hours of
 * playtime; you have 12h 30m"). That publishes the thresholds to anyone who
 * fails one, which was the deliberate trade: staff answer far fewer "why can't
 * I apply?" questions, and a threshold is not a secret worth keeping.
 */

/**
 * Every rule, in the order it is shown.
 *
 *  key     - what appears in forms.requirements
 *  window  - the companion key holding this rule's window in days, if any
 *  min/max - the range the stored threshold is clamped into
 */
export const REQUIREMENT_DEFS = [
  { key: "minPlaytimeHours",       min: 1, max: 100000 },
  { key: "noPunishmentsDays",      min: 1, max: 3650 },
  { key: "minMinecraftActiveDays", min: 1, max: 365, window: "minMinecraftActiveWindowDays" },
  { key: "minDiscordActiveDays",   min: 1, max: 365, window: "minDiscordActiveWindowDays" },
  { key: "minDiscordMessages",     min: 1, max: 1000000, window: "minDiscordActiveWindowDays" },
];

/** The window keys, which are settings rather than rules in their own right. */
export const WINDOW_DEFS = [
  { key: "minMinecraftActiveWindowDays", min: 1, max: 365, fallback: 30 },
  { key: "minDiscordActiveWindowDays",   min: 1, max: 365, fallback: 30 },
];

export const DEFAULT_WINDOW_DAYS = 30;

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded <= 0) return null;
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Clamp and strip a stored requirements blob.
 *
 * Returns null when no rule survives, so an unrestricted form stores SQL NULL
 * rather than an empty object. An absent key means the check does not apply --
 * there is no "off" value to get wrong.
 */
export function normaliseRequirements(raw) {
  const source = parseBlob(raw);
  if (!source) return null;

  const out = {};

  for (const def of REQUIREMENT_DEFS) {
    const value = clampInt(source[def.key], def.min, def.max);
    if (value !== null) out[def.key] = value;
  }

  // A window only means something alongside a rule that uses it, so it is kept
  // only when one of its dependants survived.
  for (const def of WINDOW_DEFS) {
    const used = REQUIREMENT_DEFS.some((rule) => rule.window === def.key && out[rule.key] !== undefined);
    if (!used) continue;
    out[def.key] = clampInt(source[def.key], def.min, def.max) ?? def.fallback;
  }

  // Being active on more days than the window contains is unsatisfiable, so
  // the threshold is pulled back to the window rather than left as a rule
  // nobody can ever pass.
  for (const rule of ["minMinecraftActiveDays", "minDiscordActiveDays"]) {
    const def = REQUIREMENT_DEFS.find((d) => d.key === rule);
    const window = out[def.window];
    if (out[rule] !== undefined && window !== undefined && out[rule] > window) {
      out[rule] = window;
    }
  }

  return Object.keys(out).length ? out : null;
}

/**
 * Sentinel meaning "switch this inherited check off for this form".
 *
 * A form that inherits the site defaults otherwise has no way to opt out of a
 * single check -- an absent key means "inherit", so there is nothing to write
 * that means "not this one". Zero is that value, and normaliseRequirements
 * already discards it, so it can never survive into an enforced rule.
 */
export const DISABLE_CHECK = 0;

/**
 * Combine the site-wide defaults with one form's own settings.
 *
 * Both are raw, unnormalised blobs. A key set on the form wins; a key the form
 * leaves out is inherited; a key the form sets to 0 is switched off entirely
 * rather than inherited.
 *
 * Only ever called for forms that opted in. A form that has not opted in keeps
 * exactly the rules it was given -- inheriting silently would put a playtime
 * threshold on every feedback survey the moment somebody set a default.
 */
export function mergeRequirements(globals, formRequirements) {
  const base = parseBlob(globals);
  const own = parseBlob(formRequirements);

  if (!base && !own) return null;

  const merged = { ...(base ?? {}) };

  for (const [key, value] of Object.entries(own ?? {})) {
    if (Number(value) === DISABLE_CHECK) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }

  return normaliseRequirements(merged);
}

/** Shared by normaliseRequirements and mergeRequirements. */
function parseBlob(raw) {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return source;
}

/**
 * The rules a form actually enforces.
 *
 * The single place that answers "what does this form require?", so the gate,
 * the dashboard and the editor cannot disagree about it.
 */
export function effectiveRequirements(form, globals) {
  if (!form) return null;
  return form.useGlobalRequirements
    ? mergeRequirements(globals, form.requirements)
    : normaliseRequirements(form.requirements);
}

/**
 * Describe a rule set in words, without measuring anybody.
 *
 * For the editor, which needs to show an admin what a form would inherit.
 * Reuses evaluateRequirements so the phrasing is identical to what an
 * applicant is shown -- there is no second copy of the wording to drift.
 */
export function summariseRequirements(raw) {
  const rules = normaliseRequirements(raw);
  if (!rules) return [];

  // The pass/fail verdicts are meaningless with nothing measured; only the
  // label and the threshold are read.
  return evaluateRequirements(rules, {}, { skipUnmeasurableDiscord: false })
    .checks.map((check) => ({ key: check.key, label: check.label, required: check.required }));
}

/** True when a form has at least one enforced rule. */
export function hasRequirements(raw) {
  return normaliseRequirements(raw) !== null;
}

/**
 * How many rules a form enforces.
 *
 * Counts rules only -- the window keys are settings belonging to a rule, not
 * checks of their own, so "2 requirements" means two things an applicant has
 * to satisfy rather than two things stored.
 */
export function countRequirements(raw) {
  const rules = normaliseRequirements(raw);
  if (!rules) return 0;
  return REQUIREMENT_DEFS.filter((def) => rules[def.key] !== undefined).length;
}

/** "12h 30m", "45m", or "none" -- for quoting a playtime back at someone. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (!hours && !minutes) return "none";
  if (!hours) return `${minutes}m`;
  if (!minutes) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const MS_PER_DAY = 86400000;

/**
 * The instant a rolling window of `days` opens.
 *
 * Boundary rule: the window is inclusive of its own edge, so a punishment
 * exactly 90 days old still counts against a 90-day clean-record rule. That
 * direction was chosen on purpose -- a rule that says "no punishments in the
 * last 90 days" reading as 89 would be a surprise, and erring towards the
 * stricter reading is the one that cannot be gamed by waiting a few hours.
 */
export function windowStart(days, now = new Date()) {
  const span = Math.max(0, Number(days) || 0);
  return new Date(now.getTime() - span * MS_PER_DAY);
}

/** Is `when` inside a rolling window of `days`? Inclusive of the edge. */
export function isWithinWindow(when, days, now = new Date()) {
  if (!when) return false;
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() >= windowStart(days, now).getTime();
}

/**
 * Check one form's requirements against one person's measured values.
 *
 * `measured` is whatever services/formRequirementsService.js gathered:
 *
 *   playtimeSeconds       total seconds ever played (raw, not a formatted string)
 *   punishmentCount       punishments inside the noPunishmentsDays window
 *   minecraftActiveDays   distinct days with a session inside its window
 *   discordActiveDays     distinct days with a message inside its window
 *   discordMessages       messages inside the Discord window
 *   discordLinked         whether a Discord account is linked at all
 *   discordDataFrom       Date the Discord rollup starts, or null when unknown
 *
 * Returns { ok, checks }. Every rule produces a check, including the ones that
 * passed, so the dashboard and the gate page can both show the full picture
 * rather than only the first failure.
 *
 * `skipUnmeasurableDiscord` covers the cold-start problem: the daily rollup only
 * has rows from the day its listener was deployed, so for the first few weeks a
 * 30-day Discord window would fail everyone for a reason none of them can fix.
 * With it on (the default) those checks report as skipped instead of failing.
 */
export function evaluateRequirements(requirements, measured = {}, options = {}) {
  const { skipUnmeasurableDiscord = true, now = new Date() } = options;
  const rules = normaliseRequirements(requirements);
  if (!rules) return { ok: true, checks: [] };

  const checks = [];

  const add = (check) => {
    checks.push({ skipped: false, ...check });
  };

  // ── Playtime ──────────────────────────────────────────────────────────────
  if (rules.minPlaytimeHours !== undefined) {
    const seconds = Math.max(0, Number(measured.playtimeSeconds) || 0);
    const needed = rules.minPlaytimeHours * 3600;
    add({
      key: "minPlaytimeHours",
      label: "Playtime",
      required: `${plural(rules.minPlaytimeHours, "hour")} played`,
      actual: formatDuration(seconds),
      ok: seconds >= needed,
      message: `You need ${plural(rules.minPlaytimeHours, "hour")} of playtime; you have ${formatDuration(seconds)}.`,
    });
  }

  // ── Clean record ──────────────────────────────────────────────────────────
  if (rules.noPunishmentsDays !== undefined) {
    const count = Math.max(0, Number(measured.punishmentCount) || 0);
    add({
      key: "noPunishmentsDays",
      label: "Punishment history",
      required: `no punishments in the last ${plural(rules.noPunishmentsDays, "day")}`,
      actual: count === 0 ? "clean" : plural(count, "punishment"),
      ok: count === 0,
      message:
        count === 0
          ? `No punishments in the last ${plural(rules.noPunishmentsDays, "day")}.`
          : `You need a clean record for the last ${plural(rules.noPunishmentsDays, "day")}; you have ${plural(count, "punishment")} in that time.`,
    });
  }

  // ── Minecraft consistency ─────────────────────────────────────────────────
  if (rules.minMinecraftActiveDays !== undefined) {
    const window = rules.minMinecraftActiveWindowDays ?? DEFAULT_WINDOW_DAYS;
    const days = Math.max(0, Number(measured.minecraftActiveDays) || 0);
    add({
      key: "minMinecraftActiveDays",
      label: "In-game activity",
      required: `played on ${plural(rules.minMinecraftActiveDays, "day")} in the last ${window}`,
      actual: plural(days, "day"),
      ok: days >= rules.minMinecraftActiveDays,
      message: `You need to have played on ${plural(rules.minMinecraftActiveDays, "separate day")} in the last ${window}; you have played on ${plural(days, "day")}.`,
    });
  }

  // ── Discord consistency ───────────────────────────────────────────────────
  const wantsDiscord =
    rules.minDiscordActiveDays !== undefined || rules.minDiscordMessages !== undefined;

  if (wantsDiscord) {
    const window = rules.minDiscordActiveWindowDays ?? DEFAULT_WINDOW_DAYS;
    const windowStart = new Date(now.getTime() - window * 86400000);
    const from = measured.discordDataFrom ? new Date(measured.discordDataFrom) : null;
    // No data at all is the most unmeasurable case of the lot, so null counts
    // as cold start too -- otherwise a freshly deployed listener fails
    // everyone for having no history nobody was recording.
    const coldStart = skipUnmeasurableDiscord && (from === null || from > windowStart);

    // Not linked is a different failure from not active, and has a different
    // fix, so it is said plainly rather than reported as "0 days".
    const notLinked = measured.discordLinked === false;
    const unlinked = (key, label, required) => ({
      key,
      label,
      required,
      actual: "no Discord account linked",
      ok: false,
      skipped: false,
      message: "Link your Discord account to your profile before applying -- your Discord activity cannot be checked without it.",
    });

    const unmeasurable = (key, label, required) => ({
      key,
      label,
      required,
      actual: "not yet measurable",
      ok: true,
      skipped: true,
      message: from
        ? `Discord activity has only been counted since ${from.toISOString().slice(0, 10)}, which is less than ${plural(window, "day")} ago, so this check is not being applied yet.`
        : "Discord activity has not been counted for long enough yet, so this check is not being applied.",
    });

    if (rules.minDiscordActiveDays !== undefined) {
      const required = `active on ${plural(rules.minDiscordActiveDays, "day")} in the last ${window}`;
      if (notLinked) {
        checks.push(unlinked("minDiscordActiveDays", "Discord activity", required));
      } else if (coldStart) {
        checks.push(unmeasurable("minDiscordActiveDays", "Discord activity", required));
      } else {
        const days = Math.max(0, Number(measured.discordActiveDays) || 0);
        add({
          key: "minDiscordActiveDays",
          label: "Discord activity",
          required,
          actual: plural(days, "day"),
          ok: days >= rules.minDiscordActiveDays,
          message: `You need to have posted in Discord on ${plural(rules.minDiscordActiveDays, "separate day")} in the last ${window}; you have posted on ${plural(days, "day")}.`,
        });
      }
    }

    if (rules.minDiscordMessages !== undefined) {
      const required = `${plural(rules.minDiscordMessages, "message")} in the last ${window} days`;
      if (notLinked) {
        checks.push(unlinked("minDiscordMessages", "Discord messages", required));
      } else if (coldStart) {
        checks.push(unmeasurable("minDiscordMessages", "Discord messages", required));
      } else {
        const sent = Math.max(0, Number(measured.discordMessages) || 0);
        add({
          key: "minDiscordMessages",
          label: "Discord messages",
          required,
          actual: plural(sent, "message"),
          ok: sent >= rules.minDiscordMessages,
          message: `You need ${plural(rules.minDiscordMessages, "Discord message")} in the last ${plural(window, "day")}; you have sent ${plural(sent, "message")}.`,
        });
      }
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}
