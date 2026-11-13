import { describe, it, expect, vi } from "vitest";
import { checkRateLimit } from "../../lib/rateLimiter.mjs";
import { sendWebhookMessage } from "../../lib/discord/webhooks.mjs";

// report.js pulls in api/common.js, which opens DB pools at import time
// (same mocks as tests/unit/reportReasonLength.test.mjs).
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  prisma: {},
  luckpermsDb: { query: vi.fn() },
  punishmentsDb: { query: vi.fn() },
}));
vi.mock("../../controllers/announcementController.js", () => ({
  getWebAnnouncement: vi.fn(async () => null),
}));

const { fitEmbedText, EMBED_FIELD_MAX_LENGTH } = await import("../../api/routes/report.js");

function makeRes() {
  return {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send() {
      return this;
    },
  };
}

describe("checkRateLimit key option", () => {
  it("buckets per identity, so callers sharing one IP do not starve each other", () => {
    const opts = { windowMs: 60_000, max: 2 };
    const req = { ip: "10.9.9.9", method: "POST", url: "/api/user/verify", headers: {} };
    for (let i = 0; i < 2; i++) expect(checkRateLimit(req, makeRes(), { ...opts, key: "player-a" })).toBe(true);
    expect(checkRateLimit(req, makeRes(), { ...opts, key: "player-a" })).toBe(false);
    // Same proxy IP, different player: own bucket.
    expect(checkRateLimit(req, makeRes(), { ...opts, key: "player-b" })).toBe(true);
  });

  it("falls back to req.ip when the key is missing", () => {
    const opts = { windowMs: 60_000, max: 1 };
    const req = { ip: "10.9.9.10", method: "POST", url: "/x", headers: {} };
    expect(checkRateLimit(req, makeRes(), { ...opts, key: undefined })).toBe(true);
    expect(checkRateLimit(req, makeRes(), { ...opts, key: "" })).toBe(false);
  });
});

describe("sendWebhookMessage allowedMentions", () => {
  function fakeHook() {
    return {
      sent: [],
      async send(payload) {
        this.sent.push(typeof payload === "string" ? { content: payload } : payload.getJSON());
      },
    };
  }

  it("wraps string content with allowed_mentions", async () => {
    const hook = fakeHook();
    await sendWebhookMessage(hook, "hi @everyone", { allowedMentions: { parse: [] } });
    expect(hook.sent[0]).toEqual({ content: "hi @everyone", allowed_mentions: { parse: [] } });
  });

  it("merges allowed_mentions into a builder payload", async () => {
    const hook = fakeHook();
    await sendWebhookMessage(hook, { getJSON: () => ({ embeds: [{ title: "t" }] }) }, { allowedMentions: { parse: [] } });
    expect(hook.sent[0]).toEqual({ embeds: [{ title: "t" }], allowed_mentions: { parse: [] } });
  });

  it("leaves the payload untouched when not asked", async () => {
    const hook = fakeHook();
    await sendWebhookMessage(hook, "plain");
    expect(hook.sent[0]).toEqual({ content: "plain" });
  });
});

describe("fitEmbedText", () => {
  it("keeps short text and fills empty values", () => {
    expect(fitEmbedText("abc")).toBe("abc");
    expect(fitEmbedText(null)).toBe("-");
  });

  it("truncates to Discord's field limit", () => {
    const out = fitEmbedText("x".repeat(1500));
    expect(out.length).toBe(EMBED_FIELD_MAX_LENGTH);
    expect(out.endsWith("(truncated, see dashboard)")).toBe(true);
  });
});
