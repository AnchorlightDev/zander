import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockCreateNotificationsForUsers = vi.fn().mockResolvedValue(undefined);

vi.mock("../../controllers/databaseController.js", () => ({
  default: {
    query: mockDbQuery,
  },
  luckpermsDb: {
    query: vi.fn(),
  },
}));

vi.mock("../../api/common.js", () => ({
  hashEmail: vi.fn().mockResolvedValue("hash"),
}));

vi.mock("../../controllers/notificationController.js", () => ({
  createNotificationsForUsers: mockCreateNotificationsForUsers,
}));

vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({
      discord: {},
      siteConfiguration: {},
    }),
  };
});

describe("deleteTicketChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the known live channel even when the stored Discord channel id is stale", async () => {
    mockDbQuery.mockImplementation((sql, params, callback) => {
      if (typeof params === "function") {
        callback = params;
        params = [];
      }

      if (sql.includes("SHOW COLUMNS FROM supportTickets LIKE 'discordChannelId'")) {
        callback(null, [{ Field: "discordChannelId" }]);
        return;
      }

      if (sql === "SELECT * FROM supportTickets WHERE ticketId = ?") {
        callback(null, [{ ticketId: 42, discordChannelId: "stale-channel-id" }]);
        return;
      }

      if (sql === "UPDATE supportTickets SET discordChannelId = NULL WHERE ticketId = ?") {
        callback(null);
        return;
      }

      callback(new Error(`Unexpected query in test: ${sql}`));
    });

    const knownChannel = {
      id: "live-channel-id",
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const client = {
      channels: {
        fetch: vi.fn(),
      },
    };

    const { deleteTicketChannel } = await import("../../controllers/supportTicketController.js");
    const deleted = await deleteTicketChannel(client, 42, "Ticket closed", knownChannel);

    expect(deleted).toBe(true);
    expect(knownChannel.delete).toHaveBeenCalledWith("Ticket closed");
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledWith(
      "UPDATE supportTickets SET discordChannelId = NULL WHERE ticketId = ?",
      [42],
      expect.any(Function),
    );
  });

  it("keeps the channel link when the real delete call fails", async () => {
    mockDbQuery.mockImplementation((sql, params, callback) => {
      if (typeof params === "function") {
        callback = params;
        params = [];
      }

      if (sql.includes("SHOW COLUMNS FROM supportTickets LIKE 'discordChannelId'")) {
        callback(null, [{ Field: "discordChannelId" }]);
        return;
      }

      if (sql === "SELECT * FROM supportTickets WHERE ticketId = ?") {
        callback(null, [{ ticketId: 42, discordChannelId: "live-channel-id" }]);
        return;
      }

      callback(new Error(`Unexpected query in test: ${sql}`));
    });

    const knownChannel = {
      id: "live-channel-id",
      delete: vi.fn().mockRejectedValue(Object.assign(new Error("Missing Permissions"), { code: 50013 })),
    };

    const client = {
      channels: {
        fetch: vi.fn(),
      },
    };

    const { deleteTicketChannel } = await import("../../controllers/supportTicketController.js");
    const deleted = await deleteTicketChannel(client, 42, "Ticket closed", knownChannel);

    expect(deleted).toBe(false);
    expect(knownChannel.delete).toHaveBeenCalledWith("Ticket closed");
    expect(mockDbQuery).not.toHaveBeenCalledWith(
      "UPDATE supportTickets SET discordChannelId = NULL WHERE ticketId = ?",
      expect.anything(),
      expect.any(Function),
    );
  });
});
