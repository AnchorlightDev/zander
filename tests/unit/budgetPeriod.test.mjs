import { describe, it, expect } from "vitest";
import {
  budgetItemAppliesToMonth,
  hasHistoryBefore,
  parseYearMonth,
} from "../../lib/finance/budgetPeriod.mjs";

describe("budgetItemAppliesToMonth", () => {
  const removedOct2026 = { removedFromYear: 2026, removedFromMonth: 10 };

  it("applies every month when never removed", () => {
    expect(budgetItemAppliesToMonth({}, 2020, 1)).toBe(true);
    expect(budgetItemAppliesToMonth({ removedFromYear: null, removedFromMonth: null }, 2030, 12)).toBe(true);
  });

  it("applies to months before the removal month", () => {
    expect(budgetItemAppliesToMonth(removedOct2026, 2026, 9)).toBe(true);
    expect(budgetItemAppliesToMonth(removedOct2026, 2025, 12)).toBe(true);
  });

  it("does not apply from the removal month onwards, across year boundaries", () => {
    expect(budgetItemAppliesToMonth(removedOct2026, 2026, 10)).toBe(false);
    expect(budgetItemAppliesToMonth(removedOct2026, 2026, 12)).toBe(false);
    expect(budgetItemAppliesToMonth(removedOct2026, 2027, 1)).toBe(false);
  });
});

describe("hasHistoryBefore", () => {
  it("is false for an item created in or after the removal month", () => {
    expect(hasHistoryBefore(new Date(2026, 9, 15), 2026, 10)).toBe(false);
    expect(hasHistoryBefore(new Date(2026, 10, 1), 2026, 10)).toBe(false);
  });

  it("is true for an item created before the removal month", () => {
    expect(hasHistoryBefore(new Date(2026, 8, 30), 2026, 10)).toBe(true);
    expect(hasHistoryBefore(new Date(2025, 11, 1), 2026, 1)).toBe(true);
  });
});

describe("parseYearMonth", () => {
  it("parses form strings", () => {
    expect(parseYearMonth("2026", "9")).toEqual({ year: 2026, month: 9 });
  });

  it("rejects missing or out-of-range values", () => {
    expect(parseYearMonth(undefined, "9")).toBeNull();
    expect(parseYearMonth("2026", "13")).toBeNull();
    expect(parseYearMonth("2026", "0")).toBeNull();
    expect(parseYearMonth("abc", "5")).toBeNull();
  });
});
