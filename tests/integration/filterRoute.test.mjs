import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendWebhookMessage = vi.fn().mockResolvedValue(true);
vi.mock("../../lib/discord/webhooks.mjs", () => ({ sendWebhookMessage }));
vi.mock("../../controllers/userController.js", () => ({
  UserGetter: class { byUsername() { return null; } byDiscordId() { return null; } },
}));
vi.mock("../../api/common.js", () => ({
  isFeatureEnabled: () => true,
  optional: (body, key) => body?.[key],
  required: (body, key) => body?.[key],
}));

const { default: filterApiRoute } = await import("../../api/routes/filter.js");

function makeApp(features) {
  const routes = {};
  const app = { post: (path, handler) => { routes[path] = handler; } };
  filterApiRoute(app, null, { discord: { webhooks: { staffChannel: "https://discord.com/api/webhooks/1/x" } } }, null, features, { filter: {} });
  return async (body) => {
    let sent = null;
    const res = { sent: false, send(payload) { sent = payload; this.sent = true; return this; }, status() { return this; } };
    await routes["/api/filter"]({ body }, res);
    return sent;
  };
}

const bothOn = { filter: { link: true, phrase: true } };
const purifySays = (payload, ok = true) =>
  vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => payload });

beforeEach(() => {
  process.env.PURIFY_URL = "https://purify.test/";
  process.env.PURIFY_API_KEY = "secret";
  sendWebhookMessage.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/filter via Purify", () => {
  it("sends the content to Purify with the bearer key", async () => {
    const fetchMock = purifySays({ flagged: false, details: [] });
    vi.stubGlobal("fetch", fetchMock);
    const result = await makeApp(bothOn)({ content: "hello" });
    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://purify.test/filter");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toEqual({ content: "hello" });
  });

  it("blocks and alerts staff when Purify flags it", async () => {
    vi.stubGlobal("fetch", purifySays({ flagged: true, details: ["Manually Blocked Domain: discord.gg"] }));
    const result = await makeApp(bothOn)({ content: "discord.gg/abc", discordUsername: "someone" });
    expect(result.success).toBe(false);
    expect(sendWebhookMessage).toHaveBeenCalledOnce();
  });

  it("ignores link flags when the link filter is switched off", async () => {
    vi.stubGlobal("fetch", purifySays({ flagged: true, details: ["Manually Blocked Domain: discord.gg"] }));
    const result = await makeApp({ filter: { link: false, phrase: true } })({ content: "discord.gg/abc" });
    expect(result.success).toBe(true);
    expect(sendWebhookMessage).not.toHaveBeenCalled();
  });

  it("ignores profanity flags when the phrase filter is switched off", async () => {
    vi.stubGlobal("fetch", purifySays({ flagged: true, details: ["Profanity (Score: 1.2)"] }));
    const result = await makeApp({ filter: { link: true, phrase: false } })({ content: "rude" });
    expect(result.success).toBe(true);
  });

  it("lets content through when Purify is down", async () => {
    vi.stubGlobal("fetch", purifySays({}, false));
    expect((await makeApp(bothOn)({ content: "hello" })).success).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect((await makeApp(bothOn)({ content: "hello" })).success).toBe(true);
  });

  it("lets content through when Purify is not configured", async () => {
    delete process.env.PURIFY_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await makeApp(bothOn)({ content: "hello" })).success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
