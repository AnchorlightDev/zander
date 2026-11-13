import { describe, it, expect, vi } from "vitest";

vi.mock("../../api/common.js", () => ({ generateLog: async () => {} }));
vi.mock("../../services/announcementPostService.js", () => ({
  createPost: vi.fn(), updatePost: vi.fn(), deletePost: vi.fn(), getPost: vi.fn(), listPosts: vi.fn(),
}));

const { mergeWithExisting } = await import("../../lib/mcp/tools/announcements.mjs");

const existing = {
  announcementType: "web",
  enabled: false,
  body: "Old text",
  link: "/events",
  startDate: new Date("2026-11-01T00:00:00Z"),
  endDate: new Date("2026-11-10T00:00:00Z"),
};

describe("announcements_update mergeWithExisting", () => {
  it("keeps a disabled row disabled and keeps its dates when they are left out", () => {
    const merged = mergeWithExisting({ platform: "web", body: "Fixed typo" }, existing);
    expect(merged.enabled).toBe(false);
    expect(merged.body).toBe("Fixed typo");
    expect(merged.link).toBe("/events");
    expect(merged.endDate).toBe("2026-11-10T00:00:00.000Z");
  });

  it("lets the caller change or clear fields explicitly", () => {
    const merged = mergeWithExisting({ platform: "web", enabled: true, endDate: "" }, existing);
    expect(merged.enabled).toBe(true);
    expect(merged.endDate).toBe("");
    expect(merged.body).toBe("Old text");
  });

  it("does not keep the old colour text when new body text is given", () => {
    const tip = { announcementType: "tip", enabled: true, colourMessageFormat: "&6Old", body: null };
    const merged = mergeWithExisting({ platform: "tip", body: "New" }, tip);
    expect(merged.colourMessageFormat).toBeUndefined();
  });

  it("leaves a new platform alone", () => {
    expect(mergeWithExisting({ platform: "popup", body: "x" }, undefined)).toEqual({ platform: "popup", body: "x" });
  });
});
