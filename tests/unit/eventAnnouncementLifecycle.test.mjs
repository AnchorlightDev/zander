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
  announcements: { create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
  scheduledDiscordMessages: { updateMany: vi.fn() },
  event_audit_logs: { create: vi.fn() },
};

vi.mock("../../controllers/databaseController.js", () => ({ prisma: prismaMock, default: {} }));
vi.mock("../../controllers/discordController.js", () => ({ client: { isReady: () => false } }));

const { upsertEventAnnouncements, cancelEvent, deleteEvent, updatePublishedEvent, updateEvent } = await import("../../services/eventService.js");
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
  prismaMock.event_announcements.findMany.mockResolvedValue([]);
  prismaMock.announcements.findFirst.mockResolvedValue(null);
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
      .mockResolvedValueOnce([]) // duplicate check
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

describe("moving an unpublished event", () => {
  it("moves its announcements' planned times, without scheduling on_publish", async () => {
    const before = { eventId: 2, status: "draft", startAt: START, endAt: END, deletedAt: null };
    const newStart = new Date("2026-10-17T10:00:00Z");
    const after = { ...before, startAt: newStart, endAt: new Date("2026-10-17T12:00:00Z") };
    prismaMock.events.findUnique.mockResolvedValueOnce(before).mockResolvedValue(after);
    prismaMock.events.update.mockResolvedValue(after);
    prismaMock.event_announcements.findMany.mockResolvedValue([
      { id: 1, platform: "discord", status: "pending", triggerType: "before_event", offsetMinutes: 60 },
      { id: 2, platform: "motd", status: "pending", triggerType: "event_start" },
      { id: 3, platform: "discord", status: "pending", triggerType: "on_publish", scheduledFor: null },
    ]);

    await updateEvent(2, { startAt: newStart.toISOString(), endAt: after.endAt.toISOString() }, null, "t");

    const updates = prismaMock.event_announcements.update.mock.calls.map((c) => c[0]);
    expect(updates).toEqual([
      { where: { id: 1 }, data: { scheduledFor: new Date("2026-10-17T09:00:00Z") } },
      { where: { id: 2 }, data: { scheduledFor: newStart } },
    ]);
  });

  it("leaves announcements alone when the time did not change", async () => {
    const ev = { eventId: 2, status: "draft", startAt: START, endAt: END, deletedAt: null };
    prismaMock.events.findUnique.mockResolvedValue(ev);
    prismaMock.events.update.mockResolvedValue(ev);

    await updateEvent(2, { startAt: START.toISOString(), title: undefined }, null, "t");

    expect(prismaMock.event_announcements.update).not.toHaveBeenCalled();
  });
});

describe("events published before the fix", () => {
  it("relinks an old MOTD by its original window, then moves it", async () => {
    const before = { eventId: 1, status: "published", startAt: START, endAt: END, deletedAt: null };
    const newStart = new Date("2026-10-11T10:00:00Z");
    const after = { ...before, startAt: newStart, endAt: new Date("2026-10-11T12:00:00Z") };
    prismaMock.events.findUnique.mockResolvedValueOnce(before).mockResolvedValue(after);
    prismaMock.events.update.mockResolvedValue(after);
    const oldMotd = { id: 5, platform: "motd", status: "sent", triggerType: "event_start", body: "On now", linkedAnnouncementId: null };
    prismaMock.event_announcements.findMany.mockImplementation(async ({ where }) => {
      if (where.linkedAnnouncementId === null) return [oldMotd]; // unlinked lookup
      if (where.sentAt === null) return []; // legacy Discord queue
      return [{ ...oldMotd, linkedAnnouncementId: 70 }];
    });
    prismaMock.announcements.findFirst.mockResolvedValue({ announcementId: 70 });

    await updateEvent(1, { startAt: newStart.toISOString(), endAt: after.endAt.toISOString() }, null, "t");

    expect(prismaMock.announcements.findFirst.mock.calls[0][0].where).toEqual({
      announcementType: "motd", body: "On now", startDate: START, endDate: END,
    });
    expect(prismaMock.event_announcements.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { linkedAnnouncementId: 70 } });
    expect(prismaMock.announcements.updateMany).toHaveBeenCalledWith({
      where: { announcementId: 70 },
      data: expect.objectContaining({ startDate: newStart, endDate: after.endAt }),
    });
  });

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
    const before = { eventId: 1, status: "published", startAt: START, endAt: new Date("2026-10-10T11:00:00Z"), deletedAt: null };
    const after = { ...before, endAt: END };
    prismaMock.events.findUnique
      .mockResolvedValueOnce(before) // updatePublishedEvent
      .mockResolvedValueOnce(before) // updateEvent
      .mockResolvedValue(after); // recalculation reads the saved event
    prismaMock.events.update.mockResolvedValue(after);
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

describe("leftover copies from the old save bug", () => {
  it("cancels a pending copy of a sent announcement instead of scheduling it", async () => {
    const { cancelDuplicatesOfSent, DUPLICATE_OF_SENT } = await import("../../services/eventService.js");
    prismaMock.event_announcements.findMany.mockResolvedValue([
      { id: 1, status: "sent", platform: "discord", triggerType: "before_event", offsetMinutes: 60, channelId: "c1" },
      { id: 2, status: "pending", platform: "discord", triggerType: "before_event", offsetMinutes: 60, channelId: "c1" },
      { id: 3, status: "pending", platform: "discord", triggerType: "before_event", offsetMinutes: 60, channelId: "c2" },
    ]);

    expect(await cancelDuplicatesOfSent(1)).toBe(1);
    expect(prismaMock.event_announcements.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [2] } },
      data: { status: "cancelled", lastError: DUPLICATE_OF_SENT },
    });
  });

  it("does not re-create a copy when a published event is saved", async () => {
    const sentRow = { id: 7, status: "sent", platform: "discord", triggerType: "event_start", channelId: "c1" };
    prismaMock.event_announcements.findMany.mockResolvedValueOnce([sentRow]);
    prismaMock.events.findUnique.mockResolvedValue({ eventId: 1, status: "published", startAt: START, endAt: END });

    await upsertEventAnnouncements(1, [
      { id: "7", platform: "discord", triggerType: "event_start", channelId: "c1" },
      { platform: "discord", triggerType: "event_start", channelId: "c1" }, // the leftover copy
    ], null, "t");

    expect(prismaMock.event_announcements.create).not.toHaveBeenCalled();
  });
});
