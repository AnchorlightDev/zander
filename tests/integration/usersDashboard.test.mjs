import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockQuery },
}));

const {
  getUsersList,
  getUsersSummaryStats,
  getUserDetailById,
} = await import("../../controllers/usersAdminController.js");

function queueResults(...resultsInOrder) {
  let call = 0;
  mockQuery.mockImplementation((sql, params, cb) => {
    const results = resultsInOrder[call] ?? [];
    call += 1;
    cb(null, results);
  });
}

describe("usersAdminController — data exposure safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getUsersList never selects password_hash or other credential columns", async () => {
    queueResults([{ userId: 1, username: "Player1" }], [{ total: 1 }]);
    await getUsersList({ page: 1, limit: 25 });

    for (const call of mockQuery.mock.calls) {
      const sql = call[0];
      expect(sql.toLowerCase()).not.toContain("password_hash");
      expect(sql.toLowerCase()).not.toContain("codehash");
    }
  });

  it("getUserDetailById never selects password_hash directly (only a derived hasPassword boolean)", async () => {
    queueResults([{ userId: 1, username: "Player1", hasPassword: 1 }], []);
    await getUserDetailById(1);

    const [detailSql] = mockQuery.mock.calls[0];
    expect(detailSql).toContain("(password_hash IS NOT NULL)");
    // password_hash must appear exactly once — only inside the derived
    // boolean, never selected as a raw column.
    expect(detailSql.match(/password_hash/gi)).toHaveLength(1);
  });

  it("getUsersSummaryStats computes counts via SQL aggregates, not row iteration", async () => {
    queueResults([
      { totalPlayers: 10, websiteRegistered: 4, profileOnly: 3, discordLinked: 5, disabled: 1 },
    ]);
    const stats = await getUsersSummaryStats();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({
      totalPlayers: 10,
      websiteRegistered: 4,
      profileOnly: 3,
      discordLinked: 5,
      disabled: 1,
    });
  });
});

describe("usersAdminController — search and filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches by username, uuid, email, and discordId together", async () => {
    queueResults([], [{ total: 0 }]);
    await getUsersList({ search: "Cerealraptor300" });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("username LIKE ?");
    expect(sql).toContain("uuid = ?");
    expect(sql).toContain("email LIKE ?");
    expect(sql).toContain("discordId = ?");
    expect(params).toEqual(
      expect.arrayContaining(["%Cerealraptor300%", "Cerealraptor300", "%Cerealraptor300%", "Cerealraptor300"])
    );
  });

  it("filters Bedrock accounts via the Floodgate '.' prefix", async () => {
    queueResults([], [{ total: 0 }]);
    await getUsersList({ platform: "BEDROCK" });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("username LIKE '.%'");
  });

  it("filters Java accounts as NOT starting with '.'", async () => {
    queueResults([], [{ total: 0 }]);
    await getUsersList({ platform: "JAVA" });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("username NOT LIKE '.%'");
  });

  it("filters REGISTERED accounts using the same predicate as classifyAccountState", async () => {
    queueResults([], [{ total: 0 }]);
    await getUsersList({ accountState: "REGISTERED" });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("account_registered IS NOT NULL AND password_hash IS NOT NULL");
  });

  it("filters MINECRAFT_PROFILE_ONLY accounts using the same predicate as classifyAccountState", async () => {
    queueResults([], [{ total: 0 }]);
    await getUsersList({ accountState: "MINECRAFT_PROFILE_ONLY" });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("email IS NULL AND password_hash IS NULL AND account_registered IS NULL");
  });

  it("computes pagination math correctly", async () => {
    queueResults(
      Array.from({ length: 10 }, (_, i) => ({ userId: i })),
      [{ total: 42 }]
    );
    const result = await getUsersList({ page: 2, limit: 10 });

    expect(result.total).toBe(42);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(Math.ceil(result.total / result.limit)).toBe(5);

    const [, params] = mockQuery.mock.calls[0];
    expect(params.slice(-2)).toEqual([10, 10]); // LIMIT 10 OFFSET 10 (page 2)
  });
});

describe("usersAdminController — related accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only surfaces related accounts sharing the same discordId (no username-similarity matching)", async () => {
    queueResults(
      [{ userId: 1, username: "Cerealraptor300", discordId: "999" }],
      [{ userId: 2, username: ".Pizzaraptor8", discordId: "999" }]
    );

    const detail = await getUserDetailById(1);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [relatedSql, relatedParams] = mockQuery.mock.calls[1];
    expect(relatedSql).toContain("discordId = ?");
    expect(relatedParams).toEqual(["999", 1]);
    expect(detail.relatedAccounts).toEqual([{ userId: 2, username: ".Pizzaraptor8", discordId: "999" }]);
  });

  it("returns no related accounts when discordId is not set", async () => {
    queueResults([{ userId: 1, username: "Cerealraptor300", discordId: null }]);
    const detail = await getUserDetailById(1);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(detail.relatedAccounts).toEqual([]);
  });
});
