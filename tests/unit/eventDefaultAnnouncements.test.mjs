import { describe, it, expect, vi, beforeEach } from "vitest";

const model = {
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
};

vi.mock("../../controllers/databaseController.js", () => ({
  prisma: { event_default_announcements: model },
  default: {},
}));

const { getDefaultAnnouncements, upsertDefaultAnnouncements } = await import("../../services/eventTemplateService.js");

beforeEach(() => {
  Object.values(model).forEach((fn) => fn.mockReset());
});

describe("getDefaultAnnouncements", () => {
  it("returns the rows without ids or timestamps, so they can seed a new event", async () => {
    model.findMany.mockResolvedValue([
      {
        id: 4,
        label: "1h reminder",
        announcementType: "reminder",
        platform: "discord",
        channelId: "123",
        contentTemplate: "{title} starts {startRelative}",
        body: null,
        colourMessageFormat: null,
        link: null,
        popupButtonText: null,
        popupImageUrl: null,
        triggerType: "before_event",
        offsetMinutes: 60,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const [a] = await getDefaultAnnouncements();
    expect(a).not.toHaveProperty("id");
    expect(a).not.toHaveProperty("createdAt");
    expect(a).toMatchObject({ label: "1h reminder", channelId: "123", offsetMinutes: 60, enabled: true });
  });
});

describe("upsertDefaultAnnouncements", () => {
  it("replaces the whole set and fills defaults for missing fields", async () => {
    await upsertDefaultAnnouncements([{ platform: "motd", body: "Event soon", offsetMinutes: "30", enabled: false }]);

    expect(model.deleteMany).toHaveBeenCalledWith({});
    const [row] = model.createMany.mock.calls[0][0].data;
    expect(row).toMatchObject({
      platform: "motd",
      body: "Event soon",
      announcementType: "reminder",
      triggerType: "before_event",
      offsetMinutes: 30,
      enabled: false,
      channelId: null,
    });
  });

  it("clears the defaults when given an empty list", async () => {
    await upsertDefaultAnnouncements([]);
    expect(model.deleteMany).toHaveBeenCalledWith({});
    expect(model.createMany).not.toHaveBeenCalled();
  });
});
