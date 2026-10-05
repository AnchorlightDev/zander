import { describe, it, expect, vi } from "vitest";

// Both of these generators issue codes that authorise something: the
// sessionController one covers password resets and email verification, and the
// api/common one authorises linking a Minecraft account to a Discord account.
// Both previously used Math.random() (V8's xorshift128+), whose state is
// recoverable from a handful of outputs — so an attacker who could sample the
// stream from their own account could predict a victim's code.
//
// These tests pin the properties that matter: the values must come from the
// CSPRNG, and must be uniform across the full 6-digit range.

const mockDbQuery = vi.fn((sql, params, cb) => cb(null, []));

vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({ siteConfiguration: {} }),
  };
});

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockDbQuery },
}));

vi.mock("../../controllers/announcementController.js", () => ({
  getWebAnnouncement: vi.fn(),
}));

const { generateVerificationCode } = await import("../../controllers/sessionController.js");
const { generateVerifyCode } = await import("../../api/common.js");

/** Each generator, normalised to a number, with the label used in failures. */
const generators = [
  {
    name: "sessionController.generateVerificationCode (password reset / email)",
    next: async () => Number(await generateVerificationCode()),
  },
  {
    name: "api/common.generateVerifyCode (Minecraft <-> Discord link)",
    next: async () => Number(await generateVerifyCode()),
  },
];

describe.each(generators)("$name", ({ next }) => {
  it("returns a 6-digit code in range", async () => {
    for (let i = 0; i < 50; i++) {
      const code = await next();
      expect(Number.isInteger(code)).toBe(true);
      expect(code).toBeGreaterThanOrEqual(100000);
      expect(code).toBeLessThanOrEqual(999999);
    }
  });

  it("draws from the CSPRNG, not Math.random", async () => {
    // The decisive check: stub Math.random to a fixed value. A generator built
    // on it collapses to one constant; a CSPRNG-backed one is unaffected.
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.4242);
    try {
      const codes = new Set();
      for (let i = 0; i < 40; i++) codes.add(await next());
      expect(codes.size).toBeGreaterThan(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not repeat over a large sample", async () => {
    const codes = new Set();
    for (let i = 0; i < 500; i++) codes.add(await next());
    // 500 draws from 900k: a handful of birthday collisions is plausible,
    // but anything clustered indicates a narrowed range.
    expect(codes.size).toBeGreaterThan(490);
  });

  it("spreads across the whole range rather than clustering", async () => {
    const buckets = new Array(9).fill(0);
    const samples = 900;
    for (let i = 0; i < samples; i++) {
      const code = await next();
      buckets[Math.floor((code - 100000) / 100000)]++;
    }

    // Uniform expectation is 100 per bucket; allow generous slack for variance
    // while still catching a generator skewed to part of the range.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(40);
      expect(count).toBeLessThan(180);
    }
  });
});
