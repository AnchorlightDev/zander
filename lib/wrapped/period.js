/**
 * Wrapped period math.
 *
 * Default window: a **rolling 12 months ending today**. Staff pin an explicit
 * window from the dashboard (wrappedSettings) using either:
 *   - `MM-DD` strings  → that span within the current calendar year
 *   - `YYYY-MM-DD`     → those exact dates
 *   - `rollingMonths` (number) → change the rolling length
 *
 * `resolveWrappedPeriod` is pure (takes `now` + options) so it's unit-testable.
 */

const DEFAULTS = {
  enabled: true,
  periodStart: null,
  periodEnd: null,
  rollingMonths: 12,
};

const DAY_START = [0, 0, 0, 0];
const DAY_END = [23, 59, 59, 999];

function parseMmDd(value) {
  if (typeof value !== "string" || !/^\d{2}-\d{2}$/.test(value)) return null;
  const [month, day] = value.split("-").map((n) => parseInt(n, 10));
  return { month, day };
}

function parseYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map((n) => parseInt(n, 10));
  return { year, month, day };
}

/**
 * @param {Date} now
 * @param {{ periodStart?: string, periodEnd?: string, enabled?: boolean, rollingMonths?: number }} [opts]
 * @returns {{ year: number, label: string, start: Date, end: Date, active: boolean, enabled: boolean }}
 */
export function resolveWrappedPeriod(now = new Date(), opts = {}) {
  const enabled = opts.enabled ?? DEFAULTS.enabled;

  // 1) Exact YYYY-MM-DD bounds.
  const ymdStart = parseYmd(opts.periodStart);
  const ymdEnd = parseYmd(opts.periodEnd);
  if (ymdStart && ymdEnd) {
    const start = new Date(Date.UTC(ymdStart.year, ymdStart.month - 1, ymdStart.day, ...DAY_START));
    const end = new Date(Date.UTC(ymdEnd.year, ymdEnd.month - 1, ymdEnd.day, ...DAY_END));
    const year = end.getUTCFullYear();
    return { year, label: String(year), start, end, active: enabled && now >= start && now <= end, enabled };
  }

  // 2) MM-DD span within the current calendar year.
  const mdStart = parseMmDd(opts.periodStart);
  const mdEnd = parseMmDd(opts.periodEnd);
  if (mdStart && mdEnd) {
    const year = now.getUTCFullYear();
    const start = new Date(Date.UTC(year, mdStart.month - 1, mdStart.day, ...DAY_START));
    const end = new Date(Date.UTC(year, mdEnd.month - 1, mdEnd.day, ...DAY_END));
    return { year, label: String(year), start, end, active: enabled && now >= start && now <= end, enabled };
  }

  // 3) Default — rolling window ending at the end of today (UTC).
  const months = Math.max(1, Number(opts.rollingMonths ?? DEFAULTS.rollingMonths) || 12);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), ...DAY_END));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate(), ...DAY_START));
  const year = end.getUTCFullYear();
  const label = months === 12 ? String(year) : `Last ${months} months`;
  return { year, label, start, end, active: enabled, enabled };
}

// The active period is resolved by `wrappedService.getConfiguredWrappedPeriod`,
// which reads the editable `wrappedSettings` DB row (dashboard) and falls back
// to `DEFAULTS` here — config.json is no longer consulted for the period.
