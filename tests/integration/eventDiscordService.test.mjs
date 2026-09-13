import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn().mockResolvedValue({ id: "guild-event-id-123" });
const mockEdit = vi.fn().mockResolvedValue({});
const mockDelete = vi.fn().mockResolvedValue({});
const mockScheduledEventsFetch = vi.fn();

const mockGuild = {
  scheduledEvents: { create: mockCreate, fetch: mockScheduledEventsFetch },
};
const mockGuildsFetch = vi.fn().mockResolvedValue(mockGuild);

const mockClient = {
  isReady: () => true,
  guilds: { fetch: mockGuildsFetch },
  channels: { fetch: vi.fn() },
};

vi.mock("../../controllers/discordController.js", () => ({ client: mockClient }));

const mockUpdateSyncStatus = vi.fn().mockResolvedValue(undefined);
const mockLogEventAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/eventService.js", () => ({
  updateSyncStatus: mockUpdateSyncStatus,
  logEventAudit: mockLogEventAudit,
}));

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    SapphireClient: class { constructor() {} },
  };
});

// Mock prisma for updateActionRunStatus
vi.mock("../../controllers/databaseController.js", () => ({
  default: {},
  prisma: { event_actions: { update: vi.fn().mockResolvedValue({}) } },
}));

const {
  createGuildScheduledEvent,
  runDiscordActionsForEvent,
} = await import("../../services/eventDiscordService.js");

const baseEvent = {
  eventId: 1,
  title: "Test Event",
  startAt: new Date("2025-01-01T10:00:00Z"),
  endAt: new Date("2025-01-01T12:00:00Z"),
  description: null,
  locationType: "external",
  locationLabel: "Online",
  bannerUrl: null,
  slug: "test-event",
  hosts: [],
  discordGuildEventId: null,
  discordMessageId: null,
  discordChannelId: null,
  actions: [],
};

describe("createGuildScheduledEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an external guild event and persists the ID", async () => {
    const id = await createGuildScheduledEvent(baseEvent, "guild-123");
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(id).toBe("guild-event-id-123");
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(1, "discord", "ok", null, {
      discordGuildEventId: "guild-event-id-123",
    });
  });

  it("throws when no guild ID is provided", async () => {
    await expect(createGuildScheduledEvent(baseEvent, null)).rejects.toThrow("No guild ID provided");
  });

  it("throws when no guild ID is provided (empty string)", async () => {
    await expect(createGuildScheduledEvent(baseEvent, "")).rejects.toThrow("No guild ID provided");
  });

  it("creates a voice channel event when locationType is discord", async () => {
    const event = { ...baseEvent, locationType: "discord", locationDiscordChannelId: "vc-123" };
    await createGuildScheduledEvent(event, "guild-123");
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.channel).toBe("vc-123");
  });

  it("creates an external event with metadata when no voice channel", async () => {
    await createGuildScheduledEvent(baseEvent, "guild-123");
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.entityMetadata).toBeDefined();
    expect(callArg.entityMetadata.location).toBe("Online");
  });

  it("logs an audit entry after creation", async () => {
    await createGuildScheduledEvent(baseEvent, "guild-123");
    expect(mockLogEventAudit).toHaveBeenCalledWith(
      1,
      null,
      "System",
      "discord_guild_event_created",
      expect.stringContaining("guild-event-id-123")
    );
  });
});

describe("runDiscordActionsForEvent — on_update guild event behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: "new-event-id" });
  });

  it("creates a guild event on on_update when discordGuildEventId is null", async () => {
    const event = {
      ...baseEvent,
      discordGuildEventId: null,
      actions: [{
        id: 1, enabled: true, trigger: "on_update",
        actionType: "discord_guild_event", config: { guildId: "guild-456" },
      }],
    };
    await runDiscordActionsForEvent(event, "on_update", { guildId: "guild-456" });
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it("edits an existing guild event on on_update when discordGuildEventId exists", async () => {
    const guildEvent = { id: "existing-id", edit: mockEdit, delete: mockDelete };
    mockScheduledEventsFetch.mockResolvedValueOnce(guildEvent);

    const event = {
      ...baseEvent,
      discordGuildEventId: "existing-id",
      actions: [{
        id: 2, enabled: true, trigger: "on_update",
        actionType: "discord_guild_event", config: { guildId: "guild-456" },
      }],
    };
    await runDiscordActionsForEvent(event, "on_update", { guildId: "guild-456" });
    expect(mockEdit).toHaveBeenCalledOnce();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips disabled actions", async () => {
    const event = {
      ...baseEvent,
      actions: [{
        id: 3, enabled: false, trigger: "on_update",
        actionType: "discord_guild_event", config: { guildId: "guild-456" },
      }],
    };
    await runDiscordActionsForEvent(event, "on_update", { guildId: "guild-456" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips actions with non-matching trigger", async () => {
    const event = {
      ...baseEvent,
      actions: [{
        id: 4, enabled: true, trigger: "on_publish",
        actionType: "discord_guild_event", config: { guildId: "guild-456" },
      }],
    };
    await runDiscordActionsForEvent(event, "on_update", { guildId: "guild-456" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("on_publish trigger creates a new guild event", async () => {
    const event = {
      ...baseEvent,
      actions: [{
        id: 5, enabled: true, trigger: "on_publish",
        actionType: "discord_guild_event", config: { guildId: "guild-789" },
      }],
    };
    await runDiscordActionsForEvent(event, "on_publish", { guildId: "guild-789" });
    expect(mockCreate).toHaveBeenCalledOnce();
  });
});
