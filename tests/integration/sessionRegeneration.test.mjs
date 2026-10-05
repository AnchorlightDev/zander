import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";

/**
 * hydrateUserSession() calls `req.session.regenerate(["returnTo"])` at the
 * moment a visitor becomes authenticated, so that the session id they arrived
 * with cannot survive into a privileged session.
 *
 * That fix rests on two behaviours of @fastify/session that are worth pinning
 * rather than assuming — not least because the parameter is named
 * `ignoreFields` in the source while actually being a keep-list:
 *
 *   1. regenerate() issues a new session id
 *   2. the array argument names fields to KEEP, and everything else is dropped
 *
 * If a future version flipped that, the fix would silently either stop
 * protecting against fixation or start losing the post-login redirect.
 */
async function buildApp() {
  const app = Fastify();
  await app.register(fastifyCookie, { secret: "a-test-secret-value-long-enough" });
  await app.register(fastifySession, {
    cookieName: "sessionId",
    secret: "a-test-secret-value-that-is-long-enough-for-session",
    cookie: { secure: false, httpOnly: true, sameSite: "lax" },
    saveUninitialized: true,
  });

  // Stand-in for the pre-login state: a remembered destination plus some other
  // data that must not survive the privilege change.
  app.get("/seed", async (req) => {
    req.session.returnTo = "/dashboard/events";
    req.session.attackerPlanted = "should-not-survive";
    return { sessionId: req.session.sessionId };
  });

  // Mirrors what hydrateUserSession does.
  app.get("/login", async (req) => {
    const before = req.session.sessionId;
    await req.session.regenerate(["returnTo"]);
    req.session.user = { userId: 1, username: "tester" };
    return {
      before,
      after: req.session.sessionId,
      returnTo: req.session.returnTo ?? null,
      attackerPlanted: req.session.attackerPlanted ?? null,
      user: req.session.user?.username ?? null,
    };
  });

  await app.ready();
  return app;
}

/** Carry the session cookie between requests the way a browser would. */
function cookieOf(res) {
  const raw = res.headers["set-cookie"];
  if (!raw) return undefined;
  return (Array.isArray(raw) ? raw : [raw]).map((c) => c.split(";")[0]).join("; ");
}

describe("session regeneration on login", () => {
  it("issues a new session id when privilege is granted", async () => {
    const app = await buildApp();
    try {
      const seeded = await app.inject({ method: "GET", url: "/seed" });
      const jar = cookieOf(seeded);

      const res = await app.inject({
        method: "GET",
        url: "/login",
        headers: { cookie: jar },
      });
      const body = res.json();

      expect(body.before).toBeTruthy();
      expect(body.after).toBeTruthy();
      // The decisive assertion: a fixed id cannot carry into the logged-in session.
      expect(body.after).not.toBe(body.before);
    } finally {
      await app.close();
    }
  });

  it("keeps returnTo so the post-login redirect still works", async () => {
    const app = await buildApp();
    try {
      const seeded = await app.inject({ method: "GET", url: "/seed" });
      const res = await app.inject({
        method: "GET",
        url: "/login",
        headers: { cookie: cookieOf(seeded) },
      });

      expect(res.json().returnTo).toBe("/dashboard/events");
    } finally {
      await app.close();
    }
  });

  it("drops every field not named in the keep-list", async () => {
    const app = await buildApp();
    try {
      const seeded = await app.inject({ method: "GET", url: "/seed" });
      const res = await app.inject({
        method: "GET",
        url: "/login",
        headers: { cookie: cookieOf(seeded) },
      });

      // Confirms the argument is a keep-list, not an ignore-list: anything a
      // visitor put in the session before logging in must not persist.
      expect(res.json().attackerPlanted).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("still establishes the user on the regenerated session", async () => {
    const app = await buildApp();
    try {
      const seeded = await app.inject({ method: "GET", url: "/seed" });
      const res = await app.inject({
        method: "GET",
        url: "/login",
        headers: { cookie: cookieOf(seeded) },
      });

      expect(res.json().user).toBe("tester");
    } finally {
      await app.close();
    }
  });
});
