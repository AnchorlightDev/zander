import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock only the DB layer; the real validation/status/strip helpers run.
const prismaMock = {
  announcement_posts: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  announcements: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(async (cb) => cb(prismaMock)),
};
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  prisma: prismaMock,
  withDeadlockRetry: async (fn) => fn(),
}));

const svc = await import("../../services/announcementPostService.js");
const {
  validatePlatform,
  validatePost,
  derivePostStatus,
  createPost,
  updatePost,
  deletePost,
} = svc;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (cb) => cb(prismaMock));
  prismaMock.announcement_posts.create.mockResolvedValue({ postId: 10 });
  prismaMock.announcements.create.mockResolvedValue({ announcementId: 1 });
  prismaMock.announcements.findMany.mockResolvedValue([]);
});

describe("validatePlatform", () => {
  it("rejects a bad link scheme", () => {
    const errs = validatePlatform("web", { body: "hi", link: "ftp://x" });
    expect(errs.join(" ")).toMatch(/link must start/i);
  });
  it("allows /, https, http, mailto links", () => {
    for (const link of ["/store", "https://a.com", "http://a.com", "mailto:a@b.c"]) {
      expect(validatePlatform("web", { body: "hi", link })).toEqual([]);
    }
  });
  it("rejects a MOTD of more than two lines", () => {
    expect(validatePlatform("motd", { colourMessageFormat: "a\nb\nc" }).join(" ")).toMatch(/two lines/i);
    expect(validatePlatform("motd", { colourMessageFormat: "a\nb" })).toEqual([]);
  });
  it("rejects popup button text over 60 chars", () => {
    expect(validatePlatform("popup", { body: "hi", popupButtonText: "x".repeat(61) }).join(" ")).toMatch(/60 characters/i);
  });
  it("requires hologram message text and a valid countdown", () => {
    expect(validatePlatform("hologram", { colourMessageFormat: "" }).join(" ")).toMatch(/message text/i);
    expect(validatePlatform("hologram", { colourMessageFormat: "&aHi", countdownTo: "not-a-date" }).join(" ")).toMatch(/countdown/i);
    expect(validatePlatform("hologram", { colourMessageFormat: "&aHi", countdownTo: "2026-12-31T00:00:00Z" })).toEqual([]);
  });
  it("requires a message for non-hologram platforms", () => {
    expect(validatePlatform("web", {}).join(" ")).toMatch(/message is required/i);
  });
  it("rejects an end before the start", () => {
    const errs = validatePlatform("web", { body: "hi", startDate: "2026-02-01T00:00:00Z", endDate: "2026-01-01T00:00:00Z" });
    expect(errs.join(" ")).toMatch(/end time must be after/i);
  });
});

describe("validatePost", () => {
  it("needs at least one platform", () => {
    expect(validatePost({ platforms: [] }).join(" ")).toMatch(/at least one platform/i);
  });
  it("rejects a duplicate platform", () => {
    const errs = validatePost({ platforms: [{ platform: "web", body: "a" }, { platform: "web", body: "b" }] });
    expect(errs.join(" ")).toMatch(/listed twice/i);
  });
});

describe("derivePostStatus", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  it("ended when every row's endDate is in the past", () => {
    expect(derivePostStatus([{ enabled: true, endDate: "2026-01-01T00:00:00Z" }], now)).toBe("ended");
  });
  it("disabled when no row is enabled", () => {
    expect(derivePostStatus([{ enabled: false, endDate: null }], now)).toBe("disabled");
  });
  it("scheduled when every enabled row starts in the future", () => {
    expect(derivePostStatus([{ enabled: true, startDate: "2026-12-01T00:00:00Z" }], now)).toBe("scheduled");
  });
  it("active when an enabled row is inside its window", () => {
    expect(derivePostStatus([{ enabled: true, startDate: "2026-01-01T00:00:00Z", endDate: "2026-12-31T00:00:00Z" }], now)).toBe("active");
  });
});

describe("createPost", () => {
  it("creates a post and one row per platform, stripping hologram colour codes into body", async () => {
    const postId = await createPost({
      title: "Weekend event",
      shared: { enabled: true },
      platforms: [
        { platform: "web", body: "Event this weekend", link: "/events" },
        { platform: "hologram", colourMessageFormat: "&aEvent &f{countdown}", hologramGroup: "Spawn", sortOrder: 2 },
      ],
    });
    expect(postId).toBe(10);
    expect(prismaMock.announcement_posts.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.announcements.create).toHaveBeenCalledTimes(2);

    const holoData = prismaMock.announcements.create.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.announcementType === "hologram");
    expect(holoData.colourMessageFormat).toBe("&aEvent &f{countdown}");
    expect(holoData.body).toBe("Event {countdown}"); // colour codes stripped
    expect(holoData.hologramGroup).toBe("spawn"); // normalised
    expect(holoData.postId).toBe(10);
  });

  it("throws a validation error (and creates nothing) for a bad post", async () => {
    await expect(createPost({ platforms: [{ platform: "web" }] })).rejects.toThrow(/message is required/i);
    expect(prismaMock.announcement_posts.create).not.toHaveBeenCalled();
  });
});

describe("updatePost", () => {
  it("updates kept rows, adds new platforms, and removes deselected ones in one transaction", async () => {
    // Existing post has web + tip; the update keeps web, drops tip, adds popup.
    prismaMock.announcements.findMany.mockResolvedValue([
      { announcementId: 101, announcementType: "web" },
      { announcementId: 102, announcementType: "tip" },
    ]);

    await updatePost(10, {
      title: "Changed",
      shared: { enabled: true },
      platforms: [
        { platform: "web", body: "updated banner" },
        { platform: "popup", body: "new popup" },
      ],
    });

    expect(prismaMock.announcement_posts.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postId: 10 } })
    );
    // web updated in place (announcementId 101)
    expect(prismaMock.announcements.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { announcementId: 101 } })
    );
    // popup created
    expect(prismaMock.announcements.create).toHaveBeenCalledTimes(1);
    // tip (102) removed
    expect(prismaMock.announcements.deleteMany).toHaveBeenCalledWith({
      where: { announcementId: { in: [102] } },
    });
  });
});

describe("deletePost", () => {
  it("deletes the parent post (cascade removes rows)", async () => {
    await deletePost(10);
    expect(prismaMock.announcement_posts.delete).toHaveBeenCalledWith({ where: { postId: 10 } });
  });
});
