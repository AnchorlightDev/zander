import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import { ALL_FIELDS } from "../../lib/config/settingsRegistry.mjs";

vi.mock("../../controllers/discordController.js", () => ({ client: { isReady: () => false } }));
const { buildGuildDirectory, getBotGuilds, getGuildDirectory } = await import("../../services/discordDirectoryService.js");

const GUILD = "100000000000000000";

describe("buildGuildDirectory", () => {
  const channels = [
    { id: "2", name: "Staff", type: ChannelType.GuildCategory, rawPosition: 1 },
    { id: "1", name: "Community", type: ChannelType.GuildCategory, rawPosition: 0 },
    { id: "10", name: "staff-chat", type: ChannelType.GuildText, parentId: "2", rawPosition: 0 },
    { id: "11", name: "general", type: ChannelType.GuildText, parentId: "1", rawPosition: 1 },
    { id: "12", name: "news", type: ChannelType.GuildAnnouncement, parentId: "1", rawPosition: 0 },
    { id: "13", name: "rules", type: ChannelType.GuildText, rawPosition: 0 },
    { id: "14", name: "Voice", type: ChannelType.GuildVoice, parentId: "1", rawPosition: 2 },
  ];
  const roles = [
    { id: GUILD, name: "@everyone", position: 0 },
    { id: "20", name: "Member", position: 1 },
    { id: "21", name: "Admin", position: 5, color: 0xff0000 },
    { id: "22", name: "Bot role", position: 3, managed: true },
  ];
  const dir = buildGuildDirectory(channels, roles, GUILD);

  it("lists text and announcement channels only, grouped in Discord's order", () => {
    expect(dir.channels.map((c) => `${c.group}/${c.name}`)).toEqual([
      "No category/rules",
      "Community/news",
      "Community/general",
      "Staff/staff-chat",
    ]);
    expect(dir.channels.find((c) => c.name === "news").announcement).toBe(true);
  });

  it("lists categories in order", () => {
    expect(dir.categories.map((c) => c.name)).toEqual(["Community", "Staff"]);
  });

  it("lists assignable roles highest first, without @everyone or bot roles", () => {
    expect(dir.roles.map((r) => r.name)).toEqual(["Admin", "Member"]);
    expect(dir.roles[0].color).toBe("#ff0000");
  });
});

describe("when the bot is offline", () => {
  it("returns null so the page falls back to ID boxes", async () => {
    expect(await getGuildDirectory(GUILD)).toBeNull();
    expect(getBotGuilds()).toBeNull();
  });
});

describe("settings registry", () => {
  it("gives every Discord ID field a picker", () => {
    const missing = ALL_FIELDS.filter((f) => f.type === "snowflake" && !["channel", "category", "role", "guild"].includes(f.pick));
    expect(missing.map((f) => f.path)).toEqual([]);
  });
});
