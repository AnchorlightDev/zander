/**
 * lib/finance/budgetPeriod.mjs
 *
 * Month arithmetic for standing budget items. No database import, so it is
 * unit-testable on its own.
 */

/** Months since year 0, so two (year, month) pairs compare as plain numbers. */
function monthIndex(year, month) {
  return Number(year) * 12 + (Number(month) - 1);
}

/**
 * Whether a standing budget item still applies in the given month. An item
 * removed from month M applies to every month before M and to none from M on.
 */
export function budgetItemAppliesToMonth(entry, year, month) {
  if (entry?.removedFromYear == null || entry?.removedFromMonth == null) return true;
  return monthIndex(year, month) < monthIndex(entry.removedFromYear, entry.removedFromMonth);
}

/**
 * Whether an item created at `createdAt` has any months before (year, month)
 * worth preserving. If not, removing it from that month can delete it outright.
 */
export function hasHistoryBefore(createdAt, year, month) {
  if (!createdAt) return true;
  const created = new Date(createdAt);
  return monthIndex(created.getFullYear(), created.getMonth() + 1) < monthIndex(year, month);
}

/** Parse and validate a (year, month) pair from form input, or return null. */
export function parseYearMonth(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!Number.isInteger(y) || y < 2000 || y > 9999) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  return { year: y, month: m };
}
