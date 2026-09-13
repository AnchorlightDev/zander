import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockDbQuery },
  luckpermsDb: { query: vi.fn() },
}));

vi.mock("../../api/common.js", () => ({
  hashEmail: vi.fn(async (email) => `hash:${email}`),
}));

const { mergePlaceholderUser } = await import("../../controllers/userController.js");

function installUsers(rowsByUserId) {
  mockDbQuery.mockImplementation((sql, params, cb) => {
    if (/SELECT \* FROM users WHERE userId = \?/.test(sql)) {
      const row = rowsByUserId[params[0]];
      cb(null, row ? [row] : []);
      return;
    }
    // Every UPDATE / DELETE just succeeds.
    cb(null, { affectedRows: 1 });
  });
}

function sqlCalls() {
  return mockDbQuery.mock.calls.map(([sql, params]) => ({
    sql: sql.replace(/\s+/g, " ").trim(),
    params,
  }));
}

describe("mergePlaceholderUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transfers the discordId, repoints ticket references, and deletes the placeholder", async () => {
    installUsers({
      10: { userId: 10, uuid: "ghost-uuid", discordId: "discord-123", is_placeholder: 1 },
      20: { userId: 20, uuid: "real-uuid", discordId: null, is_placeholder: 0 },
    });

    const summary = await mergePlaceholderUser(10, 20);

    expect(summary).toMatchObject({
      placeholderUserId: 10,
      survivingUserId: 20,
      discordIdTransferred: true,
    });

    const calls = sqlCalls();

    // discordId moved onto the surviving row
    expect(calls).toContainEqual({
      sql: "UPDATE users SET discordId = ? WHERE userId = ?",
      params: ["discord-123", 20],
    });
    // placeholder discordId cleared before deletion
    expect(calls).toContainEqual({
      sql: "UPDATE users SET discordId = NULL WHERE userId = ?",
      params: [10],
    });

    // foreign-key references repointed onto the surviving row
    for (const table of ["supportTickets", "supportTicketMessages", "userNotifications"]) {
      expect(calls).toContainEqual({
        sql: `UPDATE ${table} SET userId = ? WHERE userId = ?`,
        params: [20, 10],
      });
    }
    expect(calls).toContainEqual({
      sql: "UPDATE IGNORE supportTicketParticipants SET userId = ? WHERE userId = ?",
      params: [20, 10],
    });

    // pending verify-link rows for the ghost uuid removed
    expect(calls).toContainEqual({
      sql: "DELETE FROM userVerifyLink WHERE uuid = ?",
      params: ["ghost-uuid"],
    });

    // placeholder row deleted last
    expect(calls).toContainEqual({
      sql: "DELETE FROM users WHERE userId = ?",
      params: [10],
    });
  });

  it("does not overwrite an existing discordId on the surviving row", async () => {
    installUsers({
      10: { userId: 10, uuid: "ghost-uuid", discordId: "discord-ghost", is_placeholder: 1 },
      20: { userId: 20, uuid: "real-uuid", discordId: "discord-real", is_placeholder: 0 },
    });

    const summary = await mergePlaceholderUser(10, 20);

    expect(summary.discordIdTransferred).toBe(false);
    expect(sqlCalls()).not.toContainEqual({
      sql: "UPDATE users SET discordId = ? WHERE userId = ?",
      params: ["discord-ghost", 20],
    });
  });

  it("rejects when the two ids are the same", async () => {
    await expect(mergePlaceholderUser(5, 5)).rejects.toThrow(/distinct/);
  });

  it("rejects when the placeholder row is missing", async () => {
    installUsers({ 20: { userId: 20, uuid: "real-uuid", is_placeholder: 0 } });
    await expect(mergePlaceholderUser(10, 20)).rejects.toThrow(/Placeholder user 10 not found/);
  });
});
