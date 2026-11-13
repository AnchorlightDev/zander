/**
 * lib/scheduler/placeholders.mjs
 *
 * Run-time placeholder substitution for scheduler actions. Only these text fields
 * are substituted: command.command, discord_message.embedTitle/embedDescription,
 * broadcast.message. Routine steps are stored elsewhere and are not substituted.
 *
 *   {date}      the run's due date in the job's timezone, e.g. "14 November 2026"
 *   {week}      the ISO week number of the due date in the job's timezone (1-53)
 *   {runNumber} the job's run counter (see computeRunNumber)
 *
 * {{ and }} produce literal braces. Any other {name} is a validation error on
 * save, so typos are caught before they are posted to players.
 */
import { DateTime } from "luxon";

export const KNOWN_PLACEHOLDERS = new Set(["date", "week", "runNumber"]);

// Which payload fields each action type substitutes.
export const SUBSTITUTED_FIELDS = {
  command: ["command"],
  discord_message: ["embedTitle", "embedDescription"],
  broadcast: ["message"],
};

const OPEN = "\u0000OPEN\u0000";
const CLOSE = "\u0000CLOSE\u0000";

/** Values for the current run. */
export function placeholderValues({ dueAt, timezone = "Australia/Sydney", runNumber } = {}) {
  const dt = DateTime.fromJSDate(new Date(dueAt), { zone: timezone });
  return {
    date: dt.isValid ? dt.toFormat("d LLLL yyyy") : "",
    week: dt.isValid ? String(dt.weekNumber) : "",
    runNumber: runNumber === null || runNumber === undefined ? "" : String(runNumber),
  };
}

/**
 * Substitute placeholders in `text`. Throws on an unknown placeholder. Values are
 * plain text. {{ }} become literal braces.
 */
export function renderPlaceholders(text, ctx) {
  if (text == null) return text;
  const values = placeholderValues(ctx);
  const protectedText = String(text).replace(/\{\{/g, OPEN).replace(/\}\}/g, CLOSE);
  const rendered = protectedText.replace(/\{(\w+)\}/g, (match, name) => {
    if (!KNOWN_PLACEHOLDERS.has(name)) throw new Error(`Unknown placeholder {${name}}`);
    return values[name];
  });
  return rendered.replace(new RegExp(OPEN, "g"), "{").replace(new RegExp(CLOSE, "g"), "}");
}

/** Unknown placeholder names in `text` (after honouring {{ }} escapes). */
export function collectUnknownPlaceholders(text) {
  if (text == null) return [];
  const protectedText = String(text).replace(/\{\{/g, OPEN).replace(/\}\}/g, CLOSE);
  const unknown = new Set();
  for (const m of protectedText.matchAll(/\{(\w+)\}/g)) {
    if (!KNOWN_PLACEHOLDERS.has(m[1])) unknown.add(m[1]);
  }
  return [...unknown];
}

/** Validate the placeholder usage of one action's payload. Returns error strings. */
export function validateActionPlaceholders(actionType, payload = {}) {
  const fields = SUBSTITUTED_FIELDS[actionType] || [];
  const errors = [];
  for (const field of fields) {
    const unknown = collectUnknownPlaceholders(payload[field]);
    for (const name of unknown) errors.push(`${actionType}.${field}: unknown placeholder {${name}}`);
  }
  return errors;
}

/**
 * Return a copy of `payload` with its substitutable fields rendered for this run.
 * For a command, the rendered value must contain no newline (a newline would let
 * a value inject a second command).
 */
export function applyActionPlaceholders(actionType, payload = {}, ctx) {
  const fields = SUBSTITUTED_FIELDS[actionType] || [];
  const out = { ...payload };
  for (const field of fields) {
    if (out[field] == null) continue;
    const rendered = renderPlaceholders(out[field], ctx);
    if (actionType === "command" && /\r|\n/.test(rendered)) {
      throw new Error("A command must not contain a newline after placeholders are filled.");
    }
    out[field] = rendered;
  }
  return out;
}

/**
 * The run counter for a scheduled run: runNumberStart plus the number of earlier
 * scheduled runs of this job that executed (succeeded, partial or failed) or
 * started (running: in progress, or orphaned by a crash mid-run, and may already
 * have posted with that number, so it must not be reused). Missed,
 * skipped and manual runs do not consume a number, so a missed week leaves no gap.
 * A manual "Run now" uses the number the next scheduled run would get (this value)
 * but is stored with runNumber = null, so it does not consume it.
 */
export function computeRunNumber(runNumberStart, priorRuns = []) {
  const consumed = priorRuns.filter(
    (r) => r.triggerType === "schedule" && ["running", "succeeded", "partial", "failed"].includes(r.status)
  ).length;
  return (Number(runNumberStart) || 1) + consumed;
}
