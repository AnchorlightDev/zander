import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the scheduled callback and the DB query.
let scheduledFn = null;
vi.mock("node-cron", () => ({
  default: {
    schedule: (expr, fn) => {
      scheduledFn = fn;
      return { start: () => {} };
    },
  },
}));

const dbQuery = vi.fn();
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: dbQuery },
}));

await import("../../cron/announcementExpiryCron.js");

describe("announcementExpiryCron", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disables expired rows instead of deleting them, in UTC", () => {
    expect(typeof scheduledFn).toBe("function");
    dbQuery.mockImplementation((sql, cb) => cb(null, { affectedRows: 0 }));

    scheduledFn();

    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE\s+announcements/i);
    expect(sql).toMatch(/enabled\s*=\s*0/i);
    expect(sql).not.toMatch(/DELETE/i);
    expect(sql).toMatch(/UTC_TIMESTAMP\(3\)/);
  });
});
