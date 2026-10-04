import { describe, it, expect, vi, beforeEach } from "vitest";
import { announcementKey, announcementSendTime, missingDefaults } from "../../lib/eventDefaultAnnouncements.js";

const prismaMock = {
  events: { findMany: vi.fn(), findUnique: vi.fn() },
  event_announcements: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  event_audit_logs: { create: vi.fn() },
  event_templates: { findMany: vi.fn() },
  event_template_announcements: { createMany: vi.fn() },
  scheduledDiscordMessages: { create: vi.fn() },
  announcements: { create: vi.fn() },
};

vi.mock("../../controllers/databaseController.js", () => ({ prisma: prismaMock, default: {} }));

const { applyDefaultAnnouncementsToEvents } = await import("../../services/eventService.js");
const { applyDefaultAnnouncementsToTemplates } = await import("../../services/eventTemplateService.js");

const NOW = new Date("2026-10-03T00:00:00Z");
const START = new Date("2026-10-10T10:00:00Z");
const END = new Date("2026-10-10T12:00:00Z");

const reminder24h = { platform: "discord", triggerType: "before_event", offsetMinutes: 1440, channelId: "111" };
const motdAtStart = { platform: "motd", triggerType: "event_start", body: "On now!" };
const onPublish = { platform: "discord", triggerType: "on_publish", channelId: "111" };

beforeEach(() => {
  for (const model of Object.values(prismaMock)) for (const fn of Object.values(model)) fn.mockReset();
});

describe("announcementKey", () => {
  it("ignores label and wording, so a reworded default still counts as present", () => {
    expect(announcementKey({ ...reminder24h, label: "A", contentTemplate: "x" }))
      .toBe(announcementKey({ ...reminder24h, label: "B", contentTemplate: "y" }));
  });

  it("treats a different Discord channel as a different announcement", () => {
    expect(announcementKey(reminder24h)).not.toBe(announcementKey({ ...reminder24h, channelId: "222" }));
  });

  it("ignores channel for non-Discord platforms", () => {
    expect(announcementKey({ ...motdAtStart, channelId: "9" })).toBe(announcementKey(motdAtStart));
  });
});

describe("announcementSendTime", () => {
  it("computes before, at and after times", () => {
    expect(announcementSendTime(reminder24h, START, END).toISOString()).toBe("2026-10-09T10:00:00.000Z");
    expect(announcementSendTime(motdAtStart, START, END).toISOString()).toBe(START.toISOString());
    expect(announcementSendTime({ triggerType: "after_event", offsetMinutes: 30 }, START, END).toISOString())
      .toBe("2026-10-10T12:30:00.000Z");
  });

  it("has no fixed time for on_publish", () => {
    expect(announcementSendTime(onPublish, START, END)).toBeNull();
  });
});

describe("missingDefaults", () => {
  it("skips defaults the event already has, and duplicates within the defaults", () => {
    const out = missingDefaults([{ ...reminder24h, label: "custom" }], [reminder24h, motdAtStart, motdAtStart]);
    expect(out).toEqual([motdAtStart]);
  });

  it("on a published event skips on_publish and anything already due", () => {
    const soonStart = new Date(NOW.getTime() + 60 * 60000); // 1h away: the 24h reminder is past
    const out = missingDefaults([], [reminder24h, motdAtStart, onPublish], {
      published: true, startAt: soonStart, endAt: END, now: NOW,
    });
    expect(out).toEqual([motdAtStart]);
  });

  it("keeps on_publish for an event that is not published yet", () => {
    expect(missingDefaults([], [onPublish], { published: false })).toEqual([onPublish]);
  });
});

describe("applyDefaultAnnouncementsToEvents", () => {
  it("dry run counts without writing", async () => {
    prismaMock.events.findMany.mockResolvedValue([
      { eventId: 1, status: "draft", startAt: START, endAt: END, announcements: [] },
      { eventId: 2, status: "draft", startAt: START, endAt: END, announcements: [reminder24h, motdAtStart] },
    ]);

    const result = await applyDefaultAnnouncementsToEvents([reminder24h, motdAtStart], { dryRun: true });
    expect(result).toEqual({ events: 1, announcements: 2, publishedEvents: 0 });
    expect(prismaMock.event_announcements.create).not.toHaveBeenCalled();
  });

  it("queues only the newly added rows on a published event", async () => {
    prismaMock.events.findMany.mockResolvedValue([
      { eventId: 5, status: "published", startAt: START, endAt: END, announcements: [] },
    ]);
    prismaMock.event_announcements.create.mockResolvedValueOnce({ id: 77 });
    prismaMock.events.findUnique.mockResolvedValue({ eventId: 5, title: "Build Off", startAt: START, endAt: END });
    prismaMock.event_announcements.findMany.mockResolvedValue([]);

    const result = await applyDefaultAnnouncementsToEvents([reminder24h, onPublish], { dryRun: false });

    expect(result).toEqual({ events: 1, announcements: 1, publishedEvents: 1 });
    expect(prismaMock.event_announcements.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.event_announcements.findMany.mock.calls[0][0].where.id).toEqual({ in: [77] });
    expect(prismaMock.event_audit_logs.create).toHaveBeenCalledTimes(1);
  });
});

describe("applyDefaultAnnouncementsToTemplates", () => {
  it("adds only what each template is missing", async () => {
    prismaMock.event_templates.findMany.mockResolvedValue([
      { templateId: 1, announcements: [reminder24h] },
      { templateId: 2, announcements: [reminder24h, motdAtStart] },
    ]);

    const result = await applyDefaultAnnouncementsToTemplates([reminder24h, motdAtStart]);
    expect(result).toEqual({ templates: 1, announcements: 1 });
    const { data } = prismaMock.event_template_announcements.createMany.mock.calls[0][0];
    expect(data).toEqual([expect.objectContaining({ templateId: 1, platform: "motd", triggerType: "event_start" })]);
  });
});
