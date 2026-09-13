import { describe, it, expect, vi, beforeEach } from "vitest";

// centsToDisplay has no side-effect imports so we can test it in isolation
// by importing just that export after mocking the prisma dependency.
vi.mock("../../controllers/databaseController.js", () => ({ default: {}, prisma: {} }));

const { centsToDisplay } = await import("../../controllers/financeController.js");

describe("centsToDisplay", () => {
  it("converts cents to dollar display", () => {
    expect(centsToDisplay(1000)).toBe("$10.00");
  });

  it("handles zero", () => {
    expect(centsToDisplay(0)).toBe("$0.00");
  });

  it("handles null/undefined as zero", () => {
    expect(centsToDisplay(null)).toBe("$0.00");
    expect(centsToDisplay(undefined)).toBe("$0.00");
  });

  it("handles fractional cents", () => {
    expect(centsToDisplay(150)).toBe("$1.50");
  });

  it("handles large values", () => {
    expect(centsToDisplay(100000)).toBe("$1,000.00");
  });

  it("respects currency option", () => {
    const result = centsToDisplay(1000, "EUR");
    expect(result).toContain("10.00");
  });

  it("falls back to USD for null currency", () => {
    expect(centsToDisplay(500, null)).toBe("$5.00");
  });
});
