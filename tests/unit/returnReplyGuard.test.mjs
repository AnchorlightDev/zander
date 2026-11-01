import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerReturnReplyGuard } from "../../lib/returnReplyGuard.mjs";

async function buildApp() {
  const app = Fastify({ logger: false });
  registerReturnReplyGuard(app);
  // A slow onSend hook, like the Prisma session save.
  let onSendRuns = 0;
  app.addHook("onSend", (req, reply, payload, done) => {
    onSendRuns++;
    setTimeout(() => done(null, payload), 20);
  });
  app.get("/bare", async (req, res) => {
    res.header("content-type", "text/html").send("<p>bare</p>");
  });
  app.get("/returned", async (req, res) => res.send("returned"));
  app.get("/value", async () => ({ ok: true }));
  app.get("/redirect", async (req, res) => {
    res.redirect("/value");
  });
  app.get("/callback", (req, res) => {
    setTimeout(() => res.send("later"), 10);
  });
  await app.ready();
  return { app, runs: () => onSendRuns };
}

describe("returnReplyGuard", () => {
  it("sends once when an async handler calls send() without returning", async () => {
    const { app, runs } = await buildApp();
    const res = await app.inject("/bare");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<p>bare</p>");
    expect(runs()).toBe(1);
  });

  it("leaves returned replies, returned values and redirects working", async () => {
    const { app } = await buildApp();
    expect((await app.inject("/returned")).body).toBe("returned");
    expect((await app.inject("/value")).json()).toEqual({ ok: true });
    const redirect = await app.inject("/redirect");
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("/value");
  });

  it("does not touch callback-style handlers that send later", async () => {
    const { app } = await buildApp();
    expect((await app.inject("/callback")).body).toBe("later");
  });
});
