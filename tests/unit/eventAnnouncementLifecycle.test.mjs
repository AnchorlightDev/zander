import { describe, it, expect, vi, beforeEach } from "vitest";
import { discordScheduledFor, parseOffsetMinutes, siteAnnouncementWindow } from "../../lib/eventAnnouncements.js";

const prismaMock = {
  events: { findUnique: vi.fn(), update: vi.fn() },
  event_announcements: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  announcements: { create: vi.fn(), updateMany: vi.fn() },
  scheduledDiscordMessages: { updateMany: vi.fn() },
  event_audit_logs: { create: vi.fn() },
};

vi.mock("../../controllers/databaseController.js", () => ({ prisma: prismaMock, default: {} }));
vi.mock("../../controllers/discordController.js", () => ({ client: { isReady: () => false } }));

const { upsertEventAnnouncements, cancelEvent, deleteEvent, updatePublishedEvent } = await import("../../services/eventService.js");
const { getDueAnnouncements, processDueAnnouncements } = await import("../../services/eventAnnouncementService.js");

const START = new Date("2026-10-10T10:00:00Z");
const END = new Date("2026-10-10T12:00:00Z");
const NOW = new Date("2026-10-03T00:00:00Z");

let nextId;
beforeEach(() => {
  for (const model of Object.values(prismaMock)) for (const fn of Object.values(model)) fn.mockReset();
  nextId = 100;
  prismaMock.event_announcements.create.mockImplementation(async ({ data }) => ({ id: nextId++, ...data }));
  prismaMock.announcements.create.mockImplementation(async () => ({ announcementId: 900 }));
});

describe("timing helpers", () => {
  it("keeps 0 as a real offset", () => {
    expect(parseOffsetMinutes("0")).toBe(0);
    expect(parseOffsetMinutes("")).toBeNull();
    expect(parseOffsetMinutes("-5")).toBeNull();
  });

  it("sends a 0-minute before_event reminder at the start, not never", () => {
    expect(discordScheduledFor({ triggerType: "before_event", offsetMinutes: null }, START, END, NOW).toISOString())
      .toBe(START.toISOString());
  });

  it("sends an overdue announcement now rather than in the past", () => {
    const late = new Date("2026-10-10T11:00:00Z");
    expect(discordScheduledFor({ triggerType: "event_start" }, START, END, late)).toEqual(late);
  });

  it("gives site announcements the same windows as before", () => {
    expect(siteAnnouncementWindow({ triggerType: "before_event", offsetMinutes: 60 }, START, END))
      .toEqual({ startDate: new Date("2026-10-10T09:00:00Z"), endDate: START });
    expect(siteAnnouncementWindow({ triggerType: "on_publish" }, START, END)).toEqual({ startDate: null, endDate: END });
  });
});

describe("upsertEventAnnouncements", () => {
  it("keeps a sent row the editor sent back instead of duplicating it", async () => {
    prismaMock.event_announcements.findMany.mockResolvedValueOnce([{ id: 7, status: "sent", linkedAnnouncementId: null }]);
    prismaMock.events.findUnique.mockResolvedValue({ status: "draft" });

    await upsertEventAnnouncements(1, [{ id: "7", platform: "discord" }, { platform: "motd", body: "new" }], null, "t");

    expect(prismaMock.event_announcements.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.event_announcements.create.mock.calls[0][0].data).toMatchObject({ platform: "motd", status: "pending" });
    expect(prismaMock.announcements.updateMany).not.toHaveBeenCalled();
  });

  it("takes down the MOTD of a sent row that was removed", async () => {
    prismaMock.event_announcements.findMany.mockResolvedValueOnce([{ id: 7, status: "sent", linkedAnnouncementId: 55 }]);
    prismaMock.events.findUnique.mockResolvedValue({ status: "draft" });

    await upsertEventAnnouncements(1, [], null, "t");

    expect(prismaMock.announcements.updateMany).toHaveBeenCalledWith({
      where: { announcementId: { in: [55] } },
      data: expect.objectContaining({ enabled: false }),
    });
    expect(prismaMock.event_announcements.deleteMany.mock.calls[0][0].where.OR[1]).toEqual({ id: { in: [7] } });
  });

  it("schedules rows added to a published event", async () => {
    prismaMock.event_announcements.findMany
      .mockResolvedValueOnce([]) // sent rows
      .mockResolvedValueOnce([{ id: 100, platform: "discord", channelId: "c1", triggerType: "event_start", status: "pending" }]);
    prismaMock.events.findUnique
      .mockResolvedValueOnce({ status: "published" })
      .mockResolvedValueOnce({ eventId: 1, status: "published", startAt: START, endAt: END });

    await upsertEventAnnouncements(1, [{ platform: "discord", channelId: "c1", triggerType: "event_start" }], null, "t");

    // Stays pending for the cron, with a send time -- not marked sent up front
    expect(prismaMock.event_announcements.update).toHaveBeenCalledWith({ where: { id: 100 }, data: { scheduledFor: START } });
  });
});

describe("stopping a cancelled or deleted event", () => {
  for (const [name, run, event] of [
    ["cancel", () => cancelEvent(1, null, "t"), { status: "published" }],
    ["delete", () => deleteEvent(1, null, "t"), { status: "published" }],
  ]) {
    it(`${name} cancels pending rows and switches off linked site announcements`, async () => {
      prismaMock.events.findUnique.mockResolvedValue({ eventId: 1, ...event, deletedAt: null });
      prismaMock.event_announcements.findMany.mockImplementation(async ({ where }) =>
        where.sentAt === null ? [] : [{ linkedAnnouncementId: 31 }]);

      await run();

      expect(prismaMock.event_announcements.updateMany).toHaveBeenCalledWith({
        where: { eventId: 1, status: "pending" },
        data: { status: "cancelled" },
      });
      expect(prismaMock.announcements.updateMany).toHaveBeenCalledWith({
        where: { announcementId: { in: [31] } },
        data: expect.objectContaining({ enabled: false }),
      });
    });
  }
});

describe("events published before the fix", () => {
  it("cancelling pulls their messages out of the old Discord queue", async () => {
    const queuedAt = new Date(Date.now() + 86400000);
    prismaMock.events.findUnique.mockResolvedValue({ eventId: 1, status: "published", deletedAt: null });
    prismaMock.event_announcements.findMany.mockImplementation(async ({ where }) =>
      where.sentAt === null ? [{ id: 9, channelId: "c1", scheduledFor: queuedAt }] : []);

    await cancelEvent(1, null, "t");

    expect(prismaMock.scheduledDiscordMessages.updateMany).toHaveBeenCalledWith({
      where: { channelId: "c1", scheduledFor: queuedAt, status: "scheduled", sentAt: null },
      data: { status: "failed", lastError: "Event cancelled" },
    });
    expect(prismaMock.event_announcements.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { status: "cancelled" } });
  });
});

describe("rescheduling a published event", () => {
  it("moves pending Discord rows and linked site windows when only the end time changes", async () => {
    const event = { eventId: 1, status: "published", startAt: START, endAt: END, deletedAt: null };
    prismaMock.events.findUnique.mockResolvedValue(event);
    prismaMock.events.update.mockResolvedValue(event);
    prismaMock.event_announcements.findMany.mockImplementation(async ({ where }) => (where.sentAt === null ? [] : [
      { id: 1, platform: "discord", status: "pending", triggerType: "after_event", offsetMinutes: 30 },
      { id: 2, platform: "web", status: "sent", triggerType: "event_start", linkedAnnouncementId: 44 },
    ]));

    await updatePublishedEvent(1, { endAt: END.toISOString() }, null, "t");

    expect(prismaMock.event_announcements.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { scheduledFor: new Date("2026-10-10T12:30:00Z") },
    });
    expect(prismaMock.announcements.updateMany).toHaveBeenCalledWith({
      where: { announcementId: 44 },
      data: expect.objectContaining({ startDate: START, endDate: END }),
    });
  });
});

describe("announcement cron", () => {
  it("only picks up Discord announcements of published events", async () => {
    prismaMock.event_announcements.findMany.mockResolvedValue([]);
    await getDueAnnouncements();
    const { where } = prismaMock.event_announcements.findMany.mock.calls[0][0];
    expect(where.platform).toBe("discord");
    expect(where.event).toEqual({ status: "published", deletedAt: null });
  });

  it("waits while the bot is not connected instead of failing announcements", async () => {
    const result = await processDueAnnouncements();
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(prismaMock.event_announcements.findMany).not.toHaveBeenCalled();
    expect(prismaMock.event_announcements.update).not.toHaveBeenCalled();
  });
});
