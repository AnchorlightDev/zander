/**
 * tests/unit/formRequirementsService.test.mjs
 *
 * The data-gathering half of the eligibility gate: which sources get queried,
 * with what window, and what happens when a Discord account is not linked.
 *
 * The databases are mocked; what is being checked here is the wiring and the
 * SQL parameters, not MySQL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMainQuery = vi.fn();
const mockPunishmentsQuery = vi.fn();
const mockUserFindUnique = vi.fn();
const mockDiscordPunishmentCount = vi.fn();
const mockPlaytimeSeconds = vi.fn();
const mockDiscordActivity = vi.fn();
const mockTrackingStart = vi.fn();

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockMainQuery },
  punishmentsDb: { query: mockPunishmentsQuery },
  prisma: {
    users: { findUnique: (...args) => mockUserFindUnique(...args) },
    discord_punishments: { count: (...args) => mockDiscordPunishmentCount(...args) },
  },
}));

vi.mock("../../controllers/userController.js", () => ({
  getUserPlaytimeSeconds: (...args) => mockPlaytimeSeconds(...args),
}));

vi.mock("../../controllers/discordActivityController.js", () => ({
  getDiscordActivitySince: (...args) => mockDiscordActivity(...args),
  getDiscordTrackingStart: (...args) => mockTrackingStart(...args),
}));

const { checkRequirements, countMinecraftPunishments, measureUser } = await import(
  "../../services/formRequirementsService.js"
);

const NOW = new Date("2026-09-22T12:00:00.000Z");
const DAY = 86400000;

const LINKED = { userId: 7, uuid: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9", discordId: "112233445566778899" };
const UNLINKED = { userId: 8, uuid: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9", discordId: null };

/** Reply to a callback-style mysql2 query with fixed rows. */
const rows = (result) => (sql, params, callback) => callback(null, result);

beforeEach(() => {
  vi.clearAllMocks();
  mockMainQuery.mockImplementation(rows([{ activeDays: 0, totalSeconds: 0 }]));
  mockPunishmentsQuery.mockImplementation(rows([{ total: 0 }]));
  mockDiscordPunishmentCount.mockResolvedValue(0);
  mockPlaytimeSeconds.mockResolvedValue(0);
  mockDiscordActivity.mockResolvedValue({ activeDays: 0, messages: 0 });
  mockTrackingStart.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"));
  mockUserFindUnique.mockResolvedValue(LINKED);
});

describe("countMinecraftPunishments", () => {
  it("unions bans and mutes, and neither kicks nor warnings", async () => {
    await countMinecraftPunishments(LINKED.uuid, new Date(NOW.getTime() - 90 * DAY));

    const [sql] = mockPunishmentsQuery.mock.calls[0];
    expect(sql).toContain("litebans_bans");
    expect(sql).toContain("litebans_mutes");
    expect(sql).not.toContain("litebans_kicks");
    expect(sql).not.toContain("litebans_warnings");
  });

  it("normalises the UUID on both sides, because LiteBans may store it undashed", async () => {
    await countMinecraftPunishments("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9", NOW);

    const [sql, params] = mockPunishmentsQuery.mock.calls[0];
    expect(sql).toContain("REPLACE(punishments.uuid, '-', '')");
    expect(params[0]).toBe("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("compares `time` as unix milliseconds", async () => {
    const since = new Date(NOW.getTime() - 90 * DAY);
    await countMinecraftPunishments(LINKED.uuid, since);

    const [, params] = mockPunishmentsQuery.mock.calls[0];
    expect(params[1]).toBe(since.getTime());
  });

  it("does not query at all without a UUID", async () => {
    expect(await countMinecraftPunishments(null, NOW)).toBe(0);
    expect(mockPunishmentsQuery).not.toHaveBeenCalled();
  });
});

describe("punishment window", () => {
  it("looks back exactly 90 days from now", async () => {
    await measureUser(7, { noPunishmentsDays: 90 }, NOW);

    const [, params] = mockPunishmentsQuery.mock.calls[0];
    expect(params[1]).toBe(NOW.getTime() - 90 * DAY);

    const [discordArgs] = mockDiscordPunishmentCount.mock.calls[0];
    expect(discordArgs.where.created_at.gte.getTime()).toBe(NOW.getTime() - 90 * DAY);
  });

  it("adds the Minecraft and Discord counts together", async () => {
    mockPunishmentsQuery.mockImplementation(rows([{ total: 2 }]));
    mockDiscordPunishmentCount.mockResolvedValue(3);

    const measured = await measureUser(7, { noPunishmentsDays: 90 }, NOW);
    expect(measured.punishmentCount).toBe(5);
  });
});

describe("skip Discord when it is not linked", () => {
  beforeEach(() => {
    mockUserFindUnique.mockResolvedValue(UNLINKED);
  });

  it("checks Minecraft punishments but not Discord ones", async () => {
    mockPunishmentsQuery.mockImplementation(rows([{ total: 1 }]));

    const measured = await measureUser(8, { noPunishmentsDays: 90 }, NOW);

    expect(mockPunishmentsQuery).toHaveBeenCalledTimes(1);
    expect(mockDiscordPunishmentCount).not.toHaveBeenCalled();
    // The Discord half is skipped, not counted as a failure.
    expect(measured.punishmentCount).toBe(1);
    expect(measured.discordLinked).toBe(false);
  });

  it("still passes a clean unlinked player", async () => {
    const form = { formId: 1, requirements: { noPunishmentsDays: 90 } };
    const result = await checkRequirements(form, 8, NOW);
    expect(result.ok).toBe(true);
  });

  it("does not look up activity it cannot attribute to anyone", async () => {
    await measureUser(8, { minDiscordActiveDays: 8 }, NOW);
    expect(mockDiscordActivity).not.toHaveBeenCalled();
  });
});

describe("only what the rules need is queried", () => {
  it("never touches LiteBans for a form with no punishment rule", async () => {
    await measureUser(7, { minPlaytimeHours: 20 }, NOW);

    expect(mockPlaytimeSeconds).toHaveBeenCalledWith(7);
    expect(mockPunishmentsQuery).not.toHaveBeenCalled();
    expect(mockDiscordActivity).not.toHaveBeenCalled();
  });

  it("measures nothing for a form with no rules", async () => {
    expect(await measureUser(7, null, NOW)).toEqual({});
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("uses the configured Minecraft window, not the default", async () => {
    await measureUser(
      7,
      { minMinecraftActiveDays: 5, minMinecraftActiveWindowDays: 14 },
      NOW
    );

    const [sql, params] = mockMainQuery.mock.calls[0];
    expect(sql).toContain("COUNT(DISTINCT DATE(sessionStart))");
    expect(params[1].getTime()).toBe(NOW.getTime() - 14 * DAY);
  });
});

describe("checkRequirements", () => {
  it("passes a form with no rules without measuring anything", async () => {
    const result = await checkRequirements({ formId: 1, requirements: null }, 7, NOW);

    expect(result).toEqual({ ok: true, checks: [] });
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("blocks when a rule is not met", async () => {
    mockPlaytimeSeconds.mockResolvedValue(3600);

    const result = await checkRequirements(
      { formId: 1, requirements: { minPlaytimeHours: 20 } },
      7,
      NOW
    );

    expect(result.ok).toBe(false);
    expect(result.checks[0].message).toMatch(/you have 1h/);
  });

  it("opens the gate when a source is unreachable, rather than blocking everyone", async () => {
    mockPunishmentsQuery.mockImplementation((sql, params, callback) =>
      callback(new Error("litebans is down"))
    );

    const result = await checkRequirements(
      { formId: 1, requirements: { noPunishmentsDays: 90 } },
      7,
      NOW
    );

    expect(result.ok).toBe(true);
    expect(result.unavailable).toBe(true);
  });
});
