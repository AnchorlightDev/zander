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
  filterApiRoute(app, null, { discord: { webhooks: { staffChannel: "https://discord.com/api/webhooks/1/x" } }, wrapped: { minemonitor: { baseUrl: "" } } }, null, features, { filter: {} });
  return async (body) => {
    let sent = null;
    const res = { sent: false, send(payload) { sent = payload; this.sent = true; return this; }, status() { return this; } };
    await routes["/api/filter"]({ body }, res);
    return sent;
  };
}

const bothOn = { filter: { link: true, phrase: true } };
const mineMonitorSays = (payload, ok = true) =>
  vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => ({ ok: true, dryRun: false, ...payload }) });

beforeEach(() => {
  process.env.MINEMONITOR_BASE_URL = "https://monitor.test/";
  process.env.MINEMONITOR_CONNECTION_TOKEN = "secret";
  sendWebhookMessage.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/filter via MineMonitor", () => {
  it("sends the content to MineMonitor with the connection token", async () => {
    const fetchMock = mineMonitorSays({ flagged: false, details: [] });
    vi.stubGlobal("fetch", fetchMock);
    const result = await makeApp(bothOn)({ content: "hello" });
    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://monitor.test/api/filter");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toEqual({ content: "hello" });
  });

  it("blocks and alerts staff when MineMonitor flags it", async () => {
    vi.stubGlobal("fetch", mineMonitorSays({ flagged: true, details: ["Manually Blocked Domain: discord.gg"] }));
    const result = await makeApp(bothOn)({ content: "discord.gg/abc", discordUsername: "someone" });
    expect(result.success).toBe(false);
    expect(sendWebhookMessage).toHaveBeenCalledOnce();
  });

  it("alerts staff but does not block in MineMonitor's notify-only mode", async () => {
    vi.stubGlobal("fetch", mineMonitorSays({ flagged: true, dryRun: true, details: ["Profanity (Score: 1.2)"] }));
    const result = await makeApp(bothOn)({ content: "rude" });
    expect(result.success).toBe(true);
    expect(sendWebhookMessage).toHaveBeenCalledOnce();
  });

  it("lets content through when MineMonitor reports its own check failed", async () => {
    vi.stubGlobal("fetch", mineMonitorSays({ ok: false, flagged: false }));
    expect((await makeApp(bothOn)({ content: "hello" })).success).toBe(true);
  });

  it("ignores link flags when the link filter is switched off", async () => {
    vi.stubGlobal("fetch", mineMonitorSays({ flagged: true, details: ["Manually Blocked Domain: discord.gg"] }));
    const result = await makeApp({ filter: { link: false, phrase: true } })({ content: "discord.gg/abc" });
    expect(result.success).toBe(true);
    expect(sendWebhookMessage).not.toHaveBeenCalled();
  });

  it("ignores profanity flags when the phrase filter is switched off", async () => {
    vi.stubGlobal("fetch", mineMonitorSays({ flagged: true, details: ["Profanity (Score: 1.2)"] }));
    const result = await makeApp({ filter: { link: true, phrase: false } })({ content: "rude" });
    expect(result.success).toBe(true);
  });

  it("lets content through when MineMonitor is down", async () => {
    vi.stubGlobal("fetch", mineMonitorSays({}, false));
    expect((await makeApp(bothOn)({ content: "hello" })).success).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect((await makeApp(bothOn)({ content: "hello" })).success).toBe(true);
  });

  it("lets content through when MineMonitor is not configured", async () => {
    delete process.env.MINEMONITOR_BASE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await makeApp(bothOn)({ content: "hello" })).success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
