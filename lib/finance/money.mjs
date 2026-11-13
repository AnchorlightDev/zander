/**
 * Convert a dollar amount typed into a finance form (e.g. "1500", "1,500.50",
 * "$12") into whole cents.
 *
 * The account forms post the raw value of a `type=number step=0.01` input, so
 * "1500" means $1,500.00, never 1500 cents. Integer strings are therefore
 * dollars too.
 */
export function dollarsToCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const str = String(value).trim().replace(/[$,\s]/g, "");
  if (!str) return 0;
  const num = Number(str);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

/**
 * Pick the community-support figure from per-currency webstore revenue.
 *
 * Amounts in different currencies cannot be added without an exchange rate,
 * so the headline is the total in `preferredCurrency` (the budget's currency).
 * With no preferred currency, the currency that took the most is used.
 * Anything taken in other currencies is returned separately, not dropped.
 *
 * @param {Array<{currency: string, totalCents: number}>} rows
 * @param {string|null} preferredCurrency
 * @returns {{currency: string|null, cents: number, otherCurrencies: Array<{currency: string, cents: number}>}}
 */
export function pickSupportTotal(rows, preferredCurrency = null) {
  const totals = new Map();
  for (const row of rows || []) {
    const cur = String(row.currency || "").trim().toUpperCase();
    if (!cur) continue;
    totals.set(cur, (totals.get(cur) || 0) + (Number(row.totalCents) || 0));
  }

  let currency = preferredCurrency ? String(preferredCurrency).trim().toUpperCase() : null;
  if (!currency) {
    for (const [cur, cents] of totals) {
      if (currency === null || cents > totals.get(currency)) currency = cur;
    }
  }

  const otherCurrencies = [...totals.entries()]
    .filter(([cur, cents]) => cur !== currency && cents !== 0)
    .map(([cur, cents]) => ({ currency: cur, cents }));

  return { currency, cents: currency ? totals.get(currency) || 0 : 0, otherCurrencies };
}
