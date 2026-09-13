import { describe, it, expect, vi } from "vitest";

const mockQuery = vi.fn();
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockQuery },
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((expr, fn) => {
      globalThis.__cronExpr = expr;
      globalThis.__cronTask = fn;
      return { start: vi.fn() };
    }),
  },
}));

vi.mock("discord.js", () => ({ Colors: { Blurple: 0x5865f2 } }));
vi.mock("discord-webhook-node", () => ({
  MessageBuilder: class {
    setTitle() { return this; }
    setDescription() { return this; }
    setColor() { return this; }
    setFooter() { return this; }
  },
  Webhook: class { constructor() {} },
}));
vi.mock("../../lib/discord/webhooks.mjs", () => ({
  sendWebhookMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({
      discord: { webhooks: { welcome: "https://discord.com/api/webhooks/fake/url" } },
      siteConfiguration: { siteName: "TestSite" },
    }),
  };
});

await import("../../cron/cakeDayUserCheck.js");

describe("cakeDayUserCheck — SQL query", () => {
  it("is registered as a daily cron at 07:00", () => {
    expect(globalThis.__cronExpr).toBe("0 7 * * *");
  });

  it("queries only users active within the last year", async () => {
    mockQuery.mockImplementationOnce((sql, cb) => cb(null, []));
    await globalThis.__cronTask();
    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("audit_lastWebsiteLogin");
    expect(sql).toContain("DATE_SUB");
    expect(sql).toContain("INTERVAL 1 YEAR");
  });

  it("SQL filters by join anniversary and disabled accounts", async () => {
    mockQuery.mockImplementationOnce((sql, cb) => cb(null, []));
    await globalThis.__cronTask();
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("DATE_FORMAT(joined");
    expect(sql).toContain("account_disabled = 0");
    expect(sql).toContain("account_registered IS NOT NULL");
    expect(sql).toContain("YEAR(joined) != YEAR(CURDATE())");
  });

  it("announces for each user found", async () => {
    const { sendWebhookMessage } = await import("../../lib/discord/webhooks.mjs");
    vi.mocked(sendWebhookMessage).mockClear();
    mockQuery.mockImplementationOnce((sql, cb) =>
      cb(null, [
        { username: "Alice", joined: new Date("2022-06-12") },
        { username: "Bob", joined: new Date("2021-06-12") },
      ])
    );
    await globalThis.__cronTask();
    expect(sendWebhookMessage).toHaveBeenCalledTimes(2);
  });

  it("logs an error and does not crash when DB throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQuery.mockImplementationOnce((sql, cb) => cb(new Error("DB failure")));
    await expect(globalThis.__cronTask()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
