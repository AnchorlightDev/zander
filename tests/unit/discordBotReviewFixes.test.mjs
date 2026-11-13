import { describe, it, expect, vi } from "vitest";

vi.mock("../../controllers/discordPunishmentController.js", () => ({
  createPunishment: vi.fn(),
  getActivePunishments: vi.fn(),
  getPunishmentHistory: vi.fn(),
  liftPunishment: vi.fn(),
  hasActivePunishment: vi.fn(),
}));
vi.mock("../../controllers/userController.js", () => ({
  getUserPermissions: vi.fn(),
  UserGetter: class {},
}));
vi.mock("../../services/profileService.js", () => ({ getUserPunishments: vi.fn() }));

const { chunkIntoFields, messageTextWithAttachments, EMBED_FIELD_VALUE_MAX } = await import(
  "../../lib/discord/embedText.mjs"
);
const { findMayFourthResponse } = await import("../../listeners/special-may4th.js");
const { parseDuration, MAX_TEMP_DURATION_MS } = await import("../../commands/punish.mjs");

describe("chunkIntoFields", () => {
  it("keeps short text in one field", () => {
    expect(chunkIntoFields("hi", "Deleted Message")).toEqual([
      { name: "Deleted Message", value: "hi", inline: false },
    ]);
  });

  it("uses [empty] for empty content", () => {
    expect(chunkIntoFields("", "X")[0].value).toBe("[empty]");
  });

  it("splits long text into fields of at most 1024 characters", () => {
    const fields = chunkIntoFields("a".repeat(2500), "Deleted Message");
    expect(fields).toHaveLength(3);
    expect(fields.every((f) => f.value.length <= EMBED_FIELD_VALUE_MAX)).toBe(true);
    expect(fields.map((f) => f.value).join("")).toBe("a".repeat(2500));
    expect(fields[1].name).toBe("Deleted Message (cont.)");
  });

  it("caps the number of fields and marks the cut", () => {
    const fields = chunkIntoFields("b".repeat(5000), "M", { maxFields: 4 });
    expect(fields).toHaveLength(4);
    expect(fields[3].value.length).toBe(EMBED_FIELD_VALUE_MAX);
    expect(fields[3].value.endsWith("…")).toBe(true);
  });
});

describe("messageTextWithAttachments", () => {
  it("appends attachment links after the content", () => {
    const attachments = new Map([["1", { name: "shot.png", url: "https://cdn.example/shot.png" }]]);
    expect(messageTextWithAttachments("look", attachments)).toBe(
      "look\n[Attachment] shot.png: https://cdn.example/shot.png"
    );
  });

  it("records attachment-only messages", () => {
    expect(messageTextWithAttachments("", [{ name: "a.txt", url: "https://x/a.txt" }])).toBe(
      "[Attachment] a.txt: https://x/a.txt"
    );
  });

  it("returns empty when there is nothing to record", () => {
    expect(messageTextWithAttachments("  ", new Map())).toBe("");
  });
});

describe("findMayFourthResponse", () => {
  it("matches whole words only", () => {
    expect(findMayFourthResponse("a thousand blocks")).toBeNull();
    expect(findMayFourthResponse("ham sandwich")).toBeNull();
    expect(findMayFourthResponse("there is SAND here")).toMatch(/don't like sand/);
  });

  it("matches multi-word triggers", () => {
    expect(findMayFourthResponse("I have the high ground!")).toMatch(/high ground/);
  });
});

describe("parseDuration", () => {
  it("parses valid durations", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
    expect(parseDuration("2w")).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("rejects zero, garbage and out-of-range values", () => {
    expect(parseDuration("0d")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("99999999w")).toBeNull();
    expect(parseDuration("366d")).toBeNull();
    expect(parseDuration("365d")).toBe(MAX_TEMP_DURATION_MS);
  });
});
