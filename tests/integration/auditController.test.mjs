import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockQuery },
}));

// Mock UserGetter - control whether a user is found
const mockByUsername = vi.fn();
const mockByDiscordId = vi.fn();
vi.mock("../../controllers/userController.js", () => ({
  UserGetter: class {
    byUsername(...args) { return mockByUsername(...args); }
    byDiscordId(...args) { return mockByDiscordId(...args); }
  },
}));

const {
  updateAudit_lastMinecraftLogin,
  updateAudit_lastMinecraftMessage,
  updateAudit_lastWebsiteLogin,
  updateAudit_lastDiscordMessage,
  updateAudit_lastDiscordVoice,
} = await import("../../controllers/auditController.js");

describe("auditController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockImplementation((sql, params, cb) => cb && cb(null, { affectedRows: 1 }));
  });

  describe("updateAudit_lastMinecraftLogin", () => {
    it("runs DB update when user exists", async () => {
      mockByUsername.mockResolvedValue({ userId: 42 });
      await updateAudit_lastMinecraftLogin("2024-01-01", "testuser");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("audit_lastMinecraftLogin"),
        ["2024-01-01", 42],
        expect.any(Function)
      );
    });

    it("does nothing when user not found", async () => {
      mockByUsername.mockResolvedValue(null);
      await updateAudit_lastMinecraftLogin("2024-01-01", "unknownuser");
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("updateAudit_lastMinecraftMessage", () => {
    it("runs DB update when user exists", async () => {
      mockByUsername.mockResolvedValue({ userId: 10 });
      await updateAudit_lastMinecraftMessage("2024-01-01", "testuser");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("audit_lastMinecraftMessage"),
        ["2024-01-01", 10],
        expect.any(Function)
      );
    });

    it("silently returns when user not found", async () => {
      mockByUsername.mockResolvedValue(null);
      await updateAudit_lastMinecraftMessage("2024-01-01", "ghost");
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("updateAudit_lastWebsiteLogin", () => {
    it("runs DB update when user exists", async () => {
      mockByUsername.mockResolvedValue({ userId: 7 });
      await updateAudit_lastWebsiteLogin("2024-06-01", "webuser");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("audit_lastWebsiteLogin"),
        ["2024-06-01", 7],
        expect.any(Function)
      );
    });

    it("silently returns when user not found", async () => {
      mockByUsername.mockResolvedValue(null);
      await updateAudit_lastWebsiteLogin("2024-06-01", "nobody");
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("updateAudit_lastDiscordMessage — unlinked account handling", () => {
    it("runs DB update when Discord user is linked", async () => {
      mockByDiscordId.mockResolvedValue({ userId: 99 });
      await updateAudit_lastDiscordMessage("2024-01-01", "123456789");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("audit_lastDiscordMessage"),
        ["2024-01-01", 99],
        expect.any(Function)
      );
    });

    it("does NOT log a warning when Discord user is unlinked", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      mockByDiscordId.mockResolvedValue(null);
      await updateAudit_lastDiscordMessage("2024-01-01", "999888777");
      expect(mockQuery).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("updateAudit_lastDiscordVoice — unlinked account handling", () => {
    it("runs DB update when Discord user is linked", async () => {
      mockByDiscordId.mockResolvedValue({ userId: 55 });
      await updateAudit_lastDiscordVoice("2024-01-01", "987654321");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("audit_lastDiscordVoice"),
        ["2024-01-01", 55],
        expect.any(Function)
      );
    });

    it("does NOT log a warning when Discord user is unlinked", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      mockByDiscordId.mockResolvedValue(null);
      await updateAudit_lastDiscordVoice("2024-01-01", "000111222");
      expect(mockQuery).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
