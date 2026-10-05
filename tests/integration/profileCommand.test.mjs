import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags } from "discord.js";

// Mock @sapphire/framework so Command is a plain base class
vi.mock("@sapphire/framework", () => ({
  Command: class {
    constructor(context, options) {
      this.context = context;
      this.options = options;
    }
  },
  RegisterBehavior: { BulkOverwrite: 1 },
}));

// The command looks profiles up in-process via the controllers below — it does
// not make an HTTP self-call — so these are the seams the tests drive.
const byUsername = vi.fn();
const byDiscordId = vi.fn();

vi.mock("../../controllers/userController.js", () => ({
  getProfilePicture: vi.fn().mockResolvedValue("https://example.com/avatar.png"),
  getUserStats: vi.fn().mockResolvedValue({ totalLogins: 10, totalPlaytime: "5h" }),
  getUserLastSession: vi.fn().mockResolvedValue({ isOnline: false, lastOnlineDiff: null }),
  UserGetter: class {
    byUsername(...args) { return byUsername(...args); }
    byDiscordId(...args) { return byDiscordId(...args); }
  },
}));
vi.mock("../../services/profileService.js", () => ({
  getUserRanks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../controllers/badgeController.js", () => ({
  getBadgesForUser: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/discord/resolveDiscordMember.mjs", () => ({
  resolveDiscordUserId: vi.fn(),
}));
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    SapphireClient: class { constructor() {} },
    EmbedBuilder: class {
      setTitle(t) { this._title = t; return this; }
      setDescription(d) { this._desc = d; return this; }
      setColor() { return this; }
      setThumbnail() { return this; }
      addFields() { return this; }
      setTimestamp() { return this; }
      setFooter() { return this; }
    },
    Colors: { Red: 0xff0000, Blurple: 0x5865f2 },
  };
});

import { resolveDiscordUserId } from "../../lib/discord/resolveDiscordMember.mjs";
const { ProfileCommand } = await import("../../commands/profile.mjs");

// chatInputRun defers immediately (to stay inside Discord's 3s ack window) and
// answers on editReply, so every response past the argument check lands there.
function buildInteraction({ username = null, discordUser = null, discordTag = null } = {}) {
  return {
    options: {
      getString: (key) => key === "username" ? username : key === "discord_tag" ? discordTag : null,
      getUser: (key) => key === "discord_user" ? discordUser : null,
    },
    user: { id: "caller-123" },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

const userRecord = {
  userId: 1,
  username: "TestPlayer",
  discordId: null,
  joined: "2022-01-01T00:00:00Z",
};

describe("profile command", () => {
  let cmd;

  beforeEach(() => {
    vi.clearAllMocks();
    byUsername.mockReset();
    byDiscordId.mockReset();
    cmd = new ProfileCommand({ name: "profile" }, {});
  });

  it("replies with guidance when no arguments are given", async () => {
    const interaction = buildInteraction();
    await cmd.chatInputRun(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral, content: expect.stringContaining("Please provide") })
    );
    // Nothing to look up, so it must answer before deferring.
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("defers before doing any lookup work", async () => {
    byUsername.mockResolvedValue(userRecord);
    const interaction = buildInteraction({ username: "TestPlayer" });
    await cmd.chatInputRun(interaction);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
  });

  it("shows 'not linked' embed when Discord user lookup returns no profile", async () => {
    vi.mocked(resolveDiscordUserId).mockResolvedValue("discord-id-999");
    byDiscordId.mockResolvedValue(null);

    const interaction = buildInteraction({ discordUser: { id: "discord-id-999" } });
    await cmd.chatInputRun(interaction);

    expect(interaction.editReply).toHaveBeenCalledOnce();
    const embed = interaction.editReply.mock.calls[0][0].embeds?.[0];
    expect(embed._desc).toContain("not linked");
  });

  it("shows generic error when username lookup returns no profile", async () => {
    byUsername.mockResolvedValue(null);

    const interaction = buildInteraction({ username: "NonExistentPlayer" });
    await cmd.chatInputRun(interaction);

    const embed = interaction.editReply.mock.calls[0][0].embeds?.[0];
    expect(embed._desc).not.toContain("not linked");
    expect(embed._desc).toContain("does not exist");
  });

  it("shows 'unable to resolve' when Discord ID cannot be resolved", async () => {
    vi.mocked(resolveDiscordUserId).mockResolvedValue(null);
    const interaction = buildInteraction({ discordUser: { id: "bad-id" } });
    await cmd.chatInputRun(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Unable to resolve") })
    );
  });

  it("reports a lookup failure when the profile query throws", async () => {
    byDiscordId.mockRejectedValue(new Error("DB unavailable"));
    vi.mocked(resolveDiscordUserId).mockResolvedValue("discord-id-1");

    const interaction = buildInteraction({ discordUser: { id: "discord-id-1" } });
    await cmd.chatInputRun(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Failed to look up") })
    );
  });

  it("renders profile embed on successful username lookup", async () => {
    byUsername.mockResolvedValue(userRecord);

    const interaction = buildInteraction({ username: "TestPlayer" });
    await cmd.chatInputRun(interaction);

    expect(interaction.editReply).toHaveBeenCalledOnce();
    const callArg = interaction.editReply.mock.calls[0][0];
    expect(callArg.embeds).toBeDefined();
    expect(callArg.embeds.length).toBeGreaterThan(0);
  });
});
