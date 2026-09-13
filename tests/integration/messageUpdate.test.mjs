import { describe, it, expect, vi, beforeEach } from "vitest";

const addFieldsMock = vi.fn().mockReturnThis();
const mockEmbed = {
  setTitle: vi.fn().mockReturnThis(),
  setColor: vi.fn().mockReturnThis(),
  setDescription: vi.fn().mockReturnThis(),
  addFields: addFieldsMock,
};

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  const embed = mockEmbed;
  return {
    ...actual,
    EmbedBuilder: class { constructor() { return embed; } },
    Colors: { Yellow: 0xfee75c },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonBuilder: class {
      setLabel() { return this; }
      setStyle() { return this; }
      setURL() { return this; }
    },
    ButtonStyle: { Link: 5 },
    WebhookClient: class { constructor() {} },
  };
});

const mockSendWebhook = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/discord/webhooks.mjs", () => ({ sendWebhookMessage: mockSendWebhook }));

vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({
      discord: { webhooks: { adminLog: "https://discord.com/api/webhooks/fake/url" } },
    }),
  };
});

const { GuildMessageUpdateListener } = await import("../../listeners/messageUpdate.js");

describe("messageUpdate listener", () => {
  let listener;
  let mockOldMessage;
  let mockNewMessage;

  beforeEach(() => {
    vi.clearAllMocks();
    listener = new GuildMessageUpdateListener({ name: "messageUpdate" }, {});
    mockOldMessage = {
      author: { bot: false, username: "testuser" },
      channel: { name: "general" },
      content: "old content",
      url: "https://discord.com/channels/1/2/3",
    };
    mockNewMessage = {
      author: { bot: false, username: "testuser" },
      channel: { name: "general" },
      content: "new content",
      url: "https://discord.com/channels/1/2/3",
    };
  });

  it("ignores messages from bots", async () => {
    mockNewMessage.author.bot = true;
    await listener.run(mockOldMessage, mockNewMessage);
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  it("sends webhook for non-bot message edits", async () => {
    await listener.run(mockOldMessage, mockNewMessage);
    expect(mockSendWebhook).toHaveBeenCalledOnce();
  });

  it("truncates old message content to 1024 characters", async () => {
    mockOldMessage.content = "A".repeat(2000);
    await listener.run(mockOldMessage, mockNewMessage);
    const [oldField] = addFieldsMock.mock.calls[0];
    expect(oldField.value.length).toBeLessThanOrEqual(1024);
  });

  it("truncates new message content to 1024 characters", async () => {
    mockNewMessage.content = "B".repeat(2000);
    await listener.run(mockOldMessage, mockNewMessage);
    const [, newField] = addFieldsMock.mock.calls[0];
    expect(newField.value.length).toBeLessThanOrEqual(1024);
  });

  it("uses [empty] placeholder for null old message content", async () => {
    mockOldMessage.content = null;
    await listener.run(mockOldMessage, mockNewMessage);
    const [oldField] = addFieldsMock.mock.calls[0];
    expect(oldField.value).toBe("[empty]");
  });

  it("uses [empty] placeholder for null new message content", async () => {
    mockNewMessage.content = null;
    await listener.run(mockOldMessage, mockNewMessage);
    const [, newField] = addFieldsMock.mock.calls[0];
    expect(newField.value).toBe("[empty]");
  });

  it("passes through content of exactly 1024 chars unchanged", async () => {
    const content = "X".repeat(1024);
    mockOldMessage.content = content;
    await listener.run(mockOldMessage, mockNewMessage);
    const [oldField] = addFieldsMock.mock.calls[0];
    expect(oldField.value).toBe(content);
    expect(oldField.value.length).toBe(1024);
  });
});
