import { describe, it, expect, vi } from "vitest";
import { parseAddress, buildGraphMessage, createGraphTransport } from "../../lib/graphMail.mjs";

const config = { tenantId: "t", clientId: "c", clientSecret: "s", sender: "support@example.com" };

function fakeFetch({ sendStatus = 202, sendBody = "" } = {}) {
  return vi.fn(async (url) => {
    if (url.includes("/oauth2/v2.0/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
    }
    return {
      ok: sendStatus >= 200 && sendStatus < 300,
      status: sendStatus,
      text: async () => sendBody,
      headers: { get: () => "req-1" },
    };
  });
}

describe("graphMail", () => {
  it("parses display-name addresses", () => {
    expect(parseAddress('"Zander" <support@example.com>')).toEqual({ address: "support@example.com", name: "Zander" });
    expect(parseAddress("a@b.com")).toEqual({ address: "a@b.com" });
  });

  it("builds an HTML Graph message", () => {
    const { message, saveToSentItems } = buildGraphMessage({
      from: '"Zander" <support@example.com>', to: "x@y.com", subject: "Hi", html: "<p>Hi</p>",
    });
    expect(saveToSentItems).toBe(false);
    expect(message.body).toEqual({ contentType: "HTML", content: "<p>Hi</p>" });
    expect(message.toRecipients).toEqual([{ emailAddress: { address: "x@y.com" } }]);
    expect(message.from.emailAddress.address).toBe("support@example.com");
  });

  it("rejects missing config", () => {
    expect(() => createGraphTransport({ ...config, clientSecret: "" })).toThrow(/clientSecret/);
  });

  it("sends via the sender mailbox and caches the token", async () => {
    const fetchImpl = fakeFetch();
    const t = createGraphTransport({ ...config, fetchImpl });
    const info = await t.sendMail({ to: "x@y.com", subject: "s", html: "h" });
    await t.sendMail({ to: "x@y.com", subject: "s", html: "h" });
    expect(info.accepted).toEqual(["x@y.com"]);
    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls.filter((u) => u.includes("token"))).toHaveLength(1);
    expect(urls[1]).toBe("https://graph.microsoft.com/v1.0/users/support%40example.com/sendMail");
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer tok");
  });

  it("surfaces Graph errors", async () => {
    const fetchImpl = fakeFetch({ sendStatus: 403, sendBody: JSON.stringify({ error: { message: "Access is denied." } }) });
    const t = createGraphTransport({ ...config, fetchImpl });
    await expect(t.sendMail({ to: "x@y.com", subject: "s", html: "h" })).rejects.toThrow(/403.*Access is denied/);
  });
});
