/**
 * lib/timezones.mjs
 *
 * The IANA time zone list, and reading a wall-clock date in one.
 *
 * Imports nothing. The list comes from the runtime's own ICU data via
 * Intl.supportedValuesOf, so there is no hard-coded array to go stale when a
 * country changes its rules, and no dependency to add.
 */

let cachedZones;

/** Every IANA zone the runtime knows, sorted. Empty if ICU is unavailable. */
export function listTimeZones() {
  if (cachedZones) return cachedZones;

  try {
    cachedZones = [...Intl.supportedValuesOf("timeZone")].sort();
  } catch {
    // A Node build without full ICU, or an engine predating the proposal.
    // Callers degrade to "no timezone offered" rather than a broken dropdown.
    cachedZones = [];
  }

  return cachedZones;
}

/**
 * Is this a zone we can actually format in?
 *
 * Tested by use rather than by list membership: a zone can be a valid alias
 * the runtime accepts without appearing in supportedValuesOf, and what matters
 * downstream is whether Intl will accept it.
 */
export function isValidTimeZone(zone) {
  const name = String(zone ?? "").trim();
  if (!name) return false;

  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The zone if usable, otherwise null. */
export function normaliseTimeZone(zone) {
  const name = String(zone ?? "").trim();
  return name && isValidTimeZone(name) ? name : null;
}

/**
 * Zones grouped by their region prefix, for a dropdown with optgroups.
 *
 * Returns [{ region, zones: [{ value, label }] }]. The label drops the region
 * and turns underscores into spaces, so "Australia/Broken_Hill" reads as
 * "Broken Hill" under an "Australia" heading.
 */
export function groupedTimeZones() {
  const groups = new Map();

  for (const zone of listTimeZones()) {
    const slash = zone.indexOf("/");
    const region = slash === -1 ? "Other" : zone.slice(0, slash);
    const rest = slash === -1 ? zone : zone.slice(slash + 1);

    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push({ value: zone, label: rest.replace(/_/g, " ") });
  }

  return [...groups.entries()]
    .map(([region, zones]) => ({ region, zones }))
    .sort((a, b) => a.region.localeCompare(b.region));
}

/**
 * The wall-clock date at `instant` in `zone`, as { year, month, day }.
 *
 * This is the whole reason a timezone is stored. 20:00 UTC on the 14th is
 * already the 15th in Brisbane, so anything that asks "is it their birthday
 * today?" against UTC gets it wrong for most of the world for part of the day.
 *
 * Falls back to UTC for an unusable zone rather than throwing.
 */
export function localDateParts(instant, zone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;

  const timeZone = normaliseTimeZone(zone) ?? "UTC";

  // en-CA gives YYYY-MM-DD, which needs no locale-specific parsing.
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .split("-")
    .map(Number);

  return { year, month, day };
}
