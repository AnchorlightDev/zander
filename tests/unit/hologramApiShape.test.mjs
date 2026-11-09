import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the mysql2 pool shim used by the announcements data module.
const mockQuery = vi.fn();
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockQuery },
}));

const { getActiveHologramFrames } = await import("../../controllers/announcementController.js");

/**
 * The hub API (GET /api/hologram/messages) is frozen: its response items must be
 * exactly { group, message, link, countdownTo, countdownFinishedText }, ordered
 * by group then sort order then id. getActiveHologramFrames() is what the route
 * now sends, so these assertions pin the shape and ordering that the (migrated)
 * data produces, byte-for-byte with the pre-merge hologram endpoint.
 */
describe("getActiveHologramFrames (frozen hub shape)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps announcement hologram rows to the exact legacy API item shape", async () => {
    const countdown = new Date("2026-12-31T13:00:00.000Z");
    // The DB returns rows already ordered by the SQL ORDER BY; the function must
    // preserve that order and not re-sort.
    mockQuery.mockImplementation((sql, params, cb) => {
      cb(null, [
        {
          hologramGroup: "default",
          colourMessageFormat: "&aHello {countdown}",
          link: "/store",
          countdownTo: countdown,
          countdownFinishedText: "&cDone!",
        },
        {
          hologramGroup: "spawn",
          colourMessageFormat: "&bWelcome",
          link: null,
          countdownTo: null,
          countdownFinishedText: null,
        },
      ]);
    });

    const frames = await getActiveHologramFrames();

    expect(frames).toEqual([
      {
        group: "default",
        message: "&aHello {countdown}",
        link: "/store",
        countdownTo: "2026-12-31T13:00:00.000Z",
        countdownFinishedText: "&cDone!",
      },
      {
        group: "spawn",
        message: "&bWelcome",
        link: null,
        countdownTo: null,
        countdownFinishedText: null,
      },
    ]);

    // Every item has exactly the five frozen keys, nothing more.
    for (const f of frames) {
      expect(Object.keys(f).sort()).toEqual(
        ["countdownFinishedText", "countdownTo", "group", "link", "message"].sort()
      );
    }
  });

  it("filters to enabled hologram rows inside their window, ordered group/sort/id", async () => {
    mockQuery.mockImplementation((sql, params, cb) => {
      expect(sql).toContain("announcementType = 'hologram'");
      expect(sql).toContain("enabled = 1");
      expect(sql).toContain("UTC_TIMESTAMP(3)");
      expect(sql).toContain("ORDER BY hologramGroup ASC, sortOrder ASC, announcementId ASC");
      cb(null, []);
    });
    const frames = await getActiveHologramFrames();
    expect(frames).toEqual([]);
  });
});
