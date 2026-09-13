import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAddTicketUserParticipant = vi.fn().mockResolvedValue(1);
const mockCreateSupportTicket = vi.fn();
const mockCreateSupportTicketMessage = vi.fn().mockResolvedValue(1);
const mockGetCategoryName = vi.fn().mockResolvedValue("General");
const mockGetCategoryPermissions = vi.fn().mockResolvedValue([]);
const mockGetSupportCategories = vi.fn().mockResolvedValue([
  { categoryId: 1, name: "General", description: "General support" },
]);
const mockGetTicketDetailsByChannel = vi.fn();
const mockGetUserIdByDiscordId = vi.fn();
const mockCreateUnlinkedUser = vi.fn();
const mockNotifyTicketStatusChange = vi.fn().mockResolvedValue(undefined);
const mockUpdateTicketStatus = vi.fn().mockResolvedValue(undefined);
const mockDeleteTicketChannel = vi.fn().mockResolvedValue(undefined);

vi.mock("../../controllers/supportTicketController.js", () => ({
  addTicketUserParticipant: mockAddTicketUserParticipant,
  createSupportTicket: mockCreateSupportTicket,
  createSupportTicketMessage: mockCreateSupportTicketMessage,
  getCategoryName: mockGetCategoryName,
  getCategoryPermissions: mockGetCategoryPermissions,
  getSupportCategories: mockGetSupportCategories,
  getTicketDetailsByChannel: mockGetTicketDetailsByChannel,
  getUserIdByDiscordId: mockGetUserIdByDiscordId,
  createUnlinkedUser: mockCreateUnlinkedUser,
  notifyTicketStatusChange: mockNotifyTicketStatusChange,
  updateTicketStatus: mockUpdateTicketStatus,
  deleteTicketChannel: mockDeleteTicketChannel,
}));

vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({
      siteConfiguration: { siteUrl: "https://example.com" },
      discord: { webhooks: {} },
    }),
  };
});

const mockChannelSend = vi.fn().mockResolvedValue({
  id: "msg-1",
  pin: vi.fn().mockResolvedValue(undefined),
});
const mockTicketChannel = { id: "ch-1", send: mockChannelSend };

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    SapphireClient: class { constructor() {} },
    EmbedBuilder: class {
      setTitle(v) { this.title = v; return this; }
      setDescription(v) { this.description = v; return this; }
      setColor(v) { this.color = v; return this; }
      addFields(...v) { this.fields = (this.fields || []).concat(v); return this; }
      setTimestamp() { return this; }
    },
    ActionRowBuilder: class {
      addComponents(...components) {
        this.components = (this.components || []).concat(components);
        return this;
      }
    },
    ButtonBuilder: class {
      setCustomId(v) { this.customId = v; return this; }
      setLabel(v) { this.label = v; return this; }
      setStyle(v) { this.style = v; return this; }
      setURL(v) { this.url = v; return this; }
      setDisabled(v) { this.disabled = v; return this; }
      setEmoji(v) { this.emoji = v; return this; }
    },
    ButtonStyle: { Link: 5, Danger: 4, Secondary: 2 },
    PermissionFlagsBits: {
      ViewChannel: 1n, SendMessages: 2n, AttachFiles: 4n,
      ReadMessageHistory: 8n, ManageMessages: 16n, ManageChannels: 32n,
    },
    Colors: { Yellow: 0xfee75c },
    ComponentType: { StringSelect: 3 },
    ModalBuilder: class {
      setCustomId() { return this; }
      setTitle() { return this; }
      addComponents() { return this; }
    },
    TextInputBuilder: class {
      setCustomId() { return this; }
      setLabel() { return this; }
      setStyle() { return this; }
      setRequired() { return this; }
      setMaxLength() { return this; }
    },
    TextInputStyle: { Short: 1, Paragraph: 2 },
    StringSelectMenuBuilder: class {
      setCustomId() { return this; }
      setPlaceholder() { return this; }
      addOptions() { return this; }
    },
  };
});

const { handleTicketCloseConfirmation, startTicketFlow } = await import("../../lib/discord/ticketFlow.mjs");

function buildInteraction() {
  const modalEditReply = vi.fn().mockResolvedValue(undefined);
  const mockModal = {
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: modalEditReply,
    fields: {
      getTextInputValue: vi.fn((key) =>
        key === "subject" ? "Test Subject" : "Test description"
      ),
    },
    user: { id: "discord-user-1", tag: "testuser#0001" },
  };

  const mockSelection = {
    values: ["1"],
    showModal: vi.fn().mockResolvedValue(undefined),
    awaitModalSubmit: vi.fn().mockResolvedValue(mockModal),
    followUp: vi.fn().mockResolvedValue(undefined),
  };

  // editReply returns a "message" object that has awaitMessageComponent
  const mockPrompt = {
    awaitMessageComponent: vi.fn().mockResolvedValue(mockSelection),
  };

  const interaction = {
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(mockPrompt),
    user: { id: "discord-user-1", tag: "testuser#0001" },
    client: {},
    _modal: mockModal,
    _modalEditReply: modalEditReply,
  };

  return interaction;
}

describe("startTicketFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSupportTicket.mockResolvedValue({ ticketId: 42, channel: mockTicketChannel });
  });

  it("prompts to link account when user is not linked", async () => {
    mockGetUserIdByDiscordId.mockResolvedValue(null);
    const interaction = buildInteraction();
    await startTicketFlow(interaction);
    // Should reply with an embed (not create a ticket)
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) })
    );
    expect(mockCreateSupportTicket).not.toHaveBeenCalled();
  });

  it("adds ticket opener as a participant after ticket creation", async () => {
    mockGetUserIdByDiscordId.mockResolvedValue(7);
    const interaction = buildInteraction();
    await startTicketFlow(interaction);
    expect(mockAddTicketUserParticipant).toHaveBeenCalledWith(42, { userId: 7 });
  });

  it("creates a ticket message with the description after ticket creation", async () => {
    mockGetUserIdByDiscordId.mockResolvedValue(7);
    const interaction = buildInteraction();
    await startTicketFlow(interaction);
    expect(mockCreateSupportTicketMessage).toHaveBeenCalledWith(
      interaction.client,
      42,
      7,
      "Test description",
      "discord"
    );
  });

  it("continues creating the ticket even if addTicketUserParticipant fails", async () => {
    mockGetUserIdByDiscordId.mockResolvedValue(7);
    mockAddTicketUserParticipant.mockRejectedValueOnce(new Error("DB error"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const interaction = buildInteraction();
    await expect(startTicketFlow(interaction)).resolves.toBeUndefined();
    expect(mockCreateSupportTicketMessage).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("sends the ticket created confirmation reply with the ticket number", async () => {
    mockGetUserIdByDiscordId.mockResolvedValue(7);
    const interaction = buildInteraction();
    await startTicketFlow(interaction);

    const lastCall = interaction._modalEditReply.mock.calls.at(-1)?.[0];
    expect(lastCall?.content).toContain("#42");
  });

  it("sends the opening message to the ticket channel", async () => {
    mockGetUserIdByDiscordId.mockResolvedValue(7);
    const interaction = buildInteraction();
    await startTicketFlow(interaction);
    expect(mockChannelSend).toHaveBeenCalledOnce();
  });

  it("posts the opener embed and a Close Ticket button to the channel", async () => {
    mockGetUserIdByDiscordId.mockResolvedValue(7);
    const interaction = buildInteraction();
    await startTicketFlow(interaction);

    const payload = mockChannelSend.mock.calls.at(-1)?.[0];
    expect(payload).toBeTruthy();

    // The opener embed, carrying the ticket subject.
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect(payload.embeds[0].title).toContain("Test Subject");

    // A Close Ticket button in the action row.
    const buttons = payload.components.flatMap((row) => row.components || []);
    const closeButton = buttons.find((b) => b.customId === "support_ticket_close");
    expect(closeButton).toBeTruthy();
    expect(closeButton.label).toBe("Close Ticket");
  });
});

describe("handleTicketCloseConfirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetTicketDetailsByChannel.mockResolvedValue({
      ticketId: 42,
      categoryId: 1,
      discordId: "discord-user-1",
    });
    mockGetUserIdByDiscordId.mockResolvedValue(7);
  });

  it("passes the current channel to deletion so close does not depend on a refetch", async () => {
    const channel = {
      id: "ch-1",
      send: vi.fn().mockResolvedValue(undefined),
      permissionOverwrites: {
        cache: { has: vi.fn().mockReturnValue(false) },
        edit: vi.fn(),
      },
    };
    const interaction = {
      customId: "support_ticket_close_confirm:ch-1",
      channel,
      client: { channels: { fetch: vi.fn() } },
      user: { id: "discord-user-1", username: "testuser", toString: () => "@testuser" },
      guild: {
        members: {
          fetch: vi.fn().mockResolvedValue({
            permissions: { has: vi.fn().mockReturnValue(true) },
            roles: { cache: { some: vi.fn().mockReturnValue(false) } },
          }),
        },
      },
      deferred: false,
      replied: false,
      isMessageComponent: () => true,
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleTicketCloseConfirmation(interaction);
    await vi.runAllTimersAsync();

    expect(mockDeleteTicketChannel).toHaveBeenCalledWith(
      interaction.client,
      42,
      "Ticket closed",
      channel
    );
    vi.useRealTimers();
  });
});
