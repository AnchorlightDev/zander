/**
 * lib/scheduler/recurrence.mjs
 *
 * Works out when a scheduled job runs. Every occurrence is computed in the job's
 * IANA timezone and returned as a UTC instant (a JS Date), so a wall-clock time
 * like "Friday 18:00 Australia/Sydney" stays 18:00 local across daylight-saving
 * changes.
 *
 * Rules (unit-tested):
 *   - A nonexistent local time (spring-forward gap) moves forward to the first
 *     valid minute.
 *   - An ambiguous local time (autumn overlap) uses the first occurrence.
 *   - Monthly on day 29-31 falls back to the last day of shorter months.
 *   - `recurInterval` counts from the job's anchor (runAt, else createdAt).
 *
 * Weekday encoding (byWeekday): ISO numbers 1=Mon .. 7=Sun, or names MON..SUN,
 * comma/space separated.
 */
import { DateTime } from "luxon";

const DAY_CAP = 366 * 6; // safety bound for daily/weekly scans
const MONTH_CAP = 12 * 12; // safety bound for monthly scans
const WEEKDAY_NAMES = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };

function parseTime(timeOfDay) {
  const [h, m] = String(timeOfDay || "00:00").split(":").map((n) => Number(n));
  return { hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 };
}

function parseWeekdays(byWeekday) {
  const out = new Set();
  for (const tok of String(byWeekday || "").split(/[,\s]+/).filter(Boolean)) {
    const n = WEEKDAY_NAMES[tok.toUpperCase()] ?? Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= 7) out.add(n);
  }
  return out;
}

/**
 * The UTC instant for a given calendar day at (hour, minute) in `zone`, applying
 * the DST rules. `day` is a luxon DateTime already in `zone`.
 */
function atLocal(day, hour, minute, zone) {
  const base = { year: day.year, month: day.month, day: day.day };
  let want = { hour, minute };
  let dt = DateTime.fromObject({ ...base, ...want, second: 0, millisecond: 0 }, { zone });

  // Spring-forward gap: luxon shifts a nonexistent wall time forward by the gap.
  // Walk the requested minute forward until it round-trips cleanly, which lands
  // on the first valid minute after the gap.
  let guard = 0;
  while ((dt.hour * 60 + dt.minute) !== (want.hour * 60 + want.minute) && guard < 180) {
    const total = want.hour * 60 + want.minute + 1;
    want = { hour: Math.floor(total / 60) % 24, minute: total % 60 };
    dt = DateTime.fromObject({ ...base, ...want, second: 0, millisecond: 0 }, { zone });
    guard += 1;
  }
  // Autumn overlap: an ambiguous wall time should use the FIRST occurrence (the
  // earlier offset). Luxon may pick the later one; if the same wall time exists
  // an hour earlier in instant with the same clock reading, prefer that.
  const earlier = dt.minus({ hours: 1 });
  if (earlier.hour === dt.hour && earlier.minute === dt.minute && earlier.offset !== dt.offset) {
    dt = earlier;
  }
  return dt;
}

function anchorDateTime(job, zone) {
  const src = job.runAt || job.createdAt || "2000-01-01T00:00:00Z";
  const dt = DateTime.fromJSDate(new Date(src), { zone });
  return dt.isValid ? dt : DateTime.fromISO("2000-01-01T00:00:00", { zone });
}

function* occurrences(job, fromUtc) {
  const zone = job.timezone || "Australia/Sydney";
  const { hour, minute } = parseTime(job.timeOfDay);
  const interval = Math.max(1, Number(job.recurInterval) || 1);
  const untilMs = job.untilDate ? new Date(job.untilDate).getTime() : null;
  const fromMs = new Date(fromUtc).getTime();
  const anchor = anchorDateTime(job, zone);
  const start = DateTime.fromJSDate(new Date(fromUtc), { zone });

  if (job.frequency === "daily") {
    const anchorDay = anchor.startOf("day");
    let day = start.startOf("day");
    for (let i = 0; i < DAY_CAP; i++, day = day.plus({ days: 1 })) {
      const diff = Math.round(day.startOf("day").diff(anchorDay, "days").days);
      if (((diff % interval) + interval) % interval !== 0) continue;
      const dt = atLocal(day, hour, minute, zone);
      if (untilMs !== null && dt.toMillis() > untilMs) return;
      if (dt.toMillis() > fromMs) yield dt.toJSDate();
    }
    return;
  }

  if (job.frequency === "weekly") {
    let weekdays = parseWeekdays(job.byWeekday);
    if (weekdays.size === 0) weekdays = new Set([anchor.weekday]);
    const anchorWeek = anchor.startOf("week");
    let day = start.startOf("day");
    for (let i = 0; i < DAY_CAP; i++, day = day.plus({ days: 1 })) {
      if (!weekdays.has(day.weekday)) continue;
      const weeks = Math.round(day.startOf("week").diff(anchorWeek, "weeks").weeks);
      if (((weeks % interval) + interval) % interval !== 0) continue;
      const dt = atLocal(day, hour, minute, zone);
      if (untilMs !== null && dt.toMillis() > untilMs) return;
      if (dt.toMillis() > fromMs) yield dt.toJSDate();
    }
    return;
  }

  if (job.frequency === "monthly") {
    const wantDay = Math.max(1, Math.min(31, Number(job.byMonthDay) || anchor.day));
    const anchorMonthIndex = anchor.year * 12 + (anchor.month - 1);
    let month = start.startOf("month");
    for (let i = 0; i < MONTH_CAP; i++, month = month.plus({ months: 1 })) {
      const idx = month.year * 12 + (month.month - 1);
      const diff = idx - anchorMonthIndex;
      if (((diff % interval) + interval) % interval !== 0) continue;
      const dayOfMonth = Math.min(wantDay, month.daysInMonth); // clamp 29-31 to month length
      const day = month.set({ day: dayOfMonth });
      const dt = atLocal(day, hour, minute, zone);
      if (untilMs !== null && dt.toMillis() > untilMs) return;
      if (dt.toMillis() > fromMs) yield dt.toJSDate();
    }
    return;
  }
}

/**
 * The next time `job` runs strictly after `afterUtc`, or null if there is none.
 * @param {object} job
 * @param {Date|string|number} afterUtc
 * @returns {Date|null}
 */
export function nextOccurrence(job, afterUtc = new Date()) {
  if (!job) return null;
  const afterMs = new Date(afterUtc).getTime();

  if (job.scheduleType === "once" || !job.frequency) {
    if (!job.runAt) return null;
    const runMs = new Date(job.runAt).getTime();
    return runMs > afterMs ? new Date(runMs) : null;
  }

  for (const occ of occurrences(job, afterUtc)) return occ;
  return null;
}

/**
 * The next `count` occurrences at or after `afterUtc`, for the UI preview.
 * @returns {Date[]}
 */
export function upcoming(job, count = 5, afterUtc = new Date()) {
  if (!job) return [];
  const out = [];

  if (job.scheduleType === "once" || !job.frequency) {
    const next = nextOccurrence(job, afterUtc);
    return next ? [next] : [];
  }

  for (const occ of occurrences(job, afterUtc)) {
    out.push(occ);
    if (out.length >= count) break;
  }
  return out;
}
