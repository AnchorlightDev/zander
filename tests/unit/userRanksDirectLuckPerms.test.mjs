import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockLuckPermsQuery = vi.fn();

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockDbQuery },
  luckpermsDb: { query: mockLuckPermsQuery },
}));

vi.mock("../../api/common.js", () => ({
  hashEmail: vi.fn(async (email) => `hash:${email}`),
}));

const { getUserRanks } = await import("../../controllers/userController.js");

describe("getUserRanks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads direct ranks from LuckPerms without relying on the legacy userRanks view", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes("FROM users WHERE LOWER(username) = LOWER(?)")) {
        cb(null, [
          {
            userId: 42,
            username: "RankTester",
            uuid: "12345678-1234-1234-1234-1234567890ab",
          },
        ]);
        return;
      }

      if (sql.includes("FROM userRanks")) {
        cb(Object.assign(new Error("Table 'zander.userRanks' doesn't exist"), { code: "ER_NO_SUCH_TABLE" }));
        return;
      }

      cb(null, []);
    });

    mockLuckPermsQuery.mockImplementation((sql, params, cb) => {
      if (sql.includes("permission LIKE 'group.%'")) {
        cb(null, [{ rankSlug: "moderator" }]);
        return;
      }

      if (sql.includes("permission LIKE 'meta.group.%.title.%'")) {
        cb(null, [{ permission: "meta.group.moderator.title.Senior Moderator" }]);
        return;
      }

      cb(null, []);
    });

    await expect(getUserRanks("RankTester")).resolves.toEqual([
      {
        rankSlug: "moderator",
        title: "Senior Moderator",
      },
    ]);

    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("FROM userRanks"),
      expect.anything(),
      expect.any(Function)
    );
  });
});
