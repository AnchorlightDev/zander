import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcrypt";

// A tiny in-memory stand-in for the one code row, honouring the conditional
// UPDATEs the way MySQL does (affectedRows only when the WHERE matched).
let row;
const query = vi.fn((sql, params, cb) => {
  const s = sql.replace(/\s+/g, " ");
  if (s.startsWith("SELECT")) return cb(null, row ? [{ ...row }] : []);
  if (s.includes("SET attempts = attempts + 1")) {
    if (!row.consumed && row.attempts < params[1]) {
      row.attempts++;
      return cb(null, { affectedRows: 1 });
    }
    return cb(null, { affectedRows: 0 });
  }
  if (s.includes("consumedAt = NOW()")) {
    if (!row.consumed) {
      row.consumed = 1;
      return cb(null, { affectedRows: 1 });
    }
    return cb(null, { affectedRows: 0 });
  }
  if (s.includes("AND attempts >=")) {
    if (row.attempts >= params[1]) row.consumed = 1;
    return cb(null, { affectedRows: 1 });
  }
  if (s.includes("SET consumed = 1 WHERE")) {
    row.consumed = 1;
    return cb(null, { affectedRows: 1 });
  }
  throw new Error("unexpected SQL " + s);
});

vi.mock("../../controllers/databaseController.js", () => ({ default: { query: (...a) => query(...a) } }));

const { verifyPasswordResetCode } = await import("../../controllers/sessionController.js");

beforeEach(async () => {
  row = {
    resetId: 1,
    userId: 5,
    codeHash: await bcrypt.hash("123456", 4),
    expiresAt: new Date(Date.now() + 60_000),
    consumed: 0,
    attempts: 0,
  };
});

describe("verifyStoredCode", () => {
  it("caps guesses at five even when they arrive in parallel", async () => {
    const guesses = Array.from({ length: 40 }, (_, i) => verifyPasswordResetCode(5, String(200000 + i)));
    const results = await Promise.all(guesses);
    expect(results.filter((r) => r.reason === "mismatch")).toHaveLength(5);
    expect(row.consumed).toBe(1);
    expect(await verifyPasswordResetCode(5, "123456")).toEqual({ valid: false, reason: "consumed" });
  });

  it("accepts the right code once", async () => {
    expect(await verifyPasswordResetCode(5, "123456")).toEqual({ valid: true });
    expect((await verifyPasswordResetCode(5, "123456")).valid).toBe(false);
  });

  it("lets the right code through on the fifth try", async () => {
    for (let i = 0; i < 4; i++) await verifyPasswordResetCode(5, "000000");
    expect(await verifyPasswordResetCode(5, "123456")).toEqual({ valid: true });
  });
});
