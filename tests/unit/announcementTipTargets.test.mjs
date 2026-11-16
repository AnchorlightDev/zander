import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { Prisma } = await import("@prisma/client");
const { normaliseTargetServers, createPost } = await import("../../services/announcementPostService.js");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (cb) => cb(prismaMock));
  prismaMock.announcement_posts.create.mockResolvedValue({ postId: 10 });
  prismaMock.announcements.create.mockResolvedValue({ announcementId: 1 });
});

describe("normaliseTargetServers", () => {
  it("lower-cases, de-duplicates and sorts", () => {
    expect(normaliseTargetServers(["Survival", "creative", "survival"])).toEqual(["creative", "survival"]);
  });
  it("accepts a comma-separated string", () => {
    expect(normaliseTargetServers("survival, hub")).toEqual(["hub", "survival"]);
  });
  it("treats empty / invalid as every server", () => {
    expect(normaliseTargetServers([])).toBeNull();
    expect(normaliseTargetServers(null)).toBeNull();
    expect(normaliseTargetServers(["bad name!", ""])).toBeNull();
  });
});

describe("tip targeting on save", () => {
  it("stores targets for a tip", async () => {
    await createPost({ platforms: [{ platform: "tip", colourMessageFormat: "&6Hi", targetServers: ["Survival"] }] });
    const data = prismaMock.announcements.create.mock.calls[0][0].data;
    expect(data.targetServers).toEqual(["survival"]);
  });
  it("stores SQL NULL for an all-servers tip and for other platforms", async () => {
    await createPost({ platforms: [
      { platform: "tip", colourMessageFormat: "&6Hi", targetServers: [] },
      { platform: "web", body: "Hi", targetServers: ["survival"] },
    ] });
    const [tip, web] = prismaMock.announcements.create.mock.calls.map((c) => c[0].data);
    expect(tip.targetServers).toBe(Prisma.DbNull);
    expect(web.targetServers).toBe(Prisma.DbNull);
  });
});
