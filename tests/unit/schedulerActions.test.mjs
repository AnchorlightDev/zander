import { describe, it, expect, vi } from "vitest";

// Keep the DB layer out of these pure validate/describe/preview tests.
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  prisma: {},
  withDeadlockRetry: async (fn) => fn(),
}));

const {
  ACTION_TYPES,
  getActionModule,
  validateAction,
} = await import("../../lib/scheduler/actions/index.mjs");

describe("action registry", () => {
  it("registers the six action types", () => {
    expect(ACTION_TYPES.sort()).toEqual(
      ["announcement_post", "broadcast", "command", "discord_message", "forum_publish", "routine"].sort()
    );
  });
  it("rejects an unknown action type", () => {
    expect(validateAction("nope", {})).toEqual(['Unknown action type "nope".']);
  });
  it("every module exports validate/describe/preview/run", () => {
    for (const type of ACTION_TYPES) {
      const mod = getActionModule(type);
      for (const fn of ["validate", "describe", "preview", "run"]) {
        expect(typeof mod[fn]).toBe("function");
      }
    }
  });
});

describe("command", () => {
  const mod = getActionModule("command");
  it("validates target + command + executeAs", () => {
    expect(mod.validate({ target: "any", command: "say hi" })).toEqual([]);
    expect(mod.validate({ command: "say hi" }).join(" ")).toMatch(/target/i);
    expect(mod.validate({ target: "any" }).join(" ")).toMatch(/command is required/i);
    expect(mod.validate({ target: "any", command: "x", executeAs: "player" }).join(" ")).toMatch(/console/i);
  });
  it("describes and previews", () => {
    expect(mod.describe({ target: "any", command: "/say hi" })).toMatch(/every server/);
    expect(mod.preview({ target: "lobby", command: "say hi" }).summary).toMatch(/lobby/);
  });
});

describe("routine", () => {
  const mod = getActionModule("routine");
  it("requires a routineSlug", () => {
    expect(mod.validate({ routineSlug: "restart" })).toEqual([]);
    expect(mod.validate({}).join(" ")).toMatch(/routineSlug/);
  });
  it("describes", () => expect(mod.describe({ routineSlug: "restart" })).toMatch(/restart/));
});

describe("discord_message", () => {
  const mod = getActionModule("discord_message");
  it("requires channelId and some content", () => {
    expect(mod.validate({ channelId: "123", embedTitle: "Hi" })).toEqual([]);
    expect(mod.validate({ embedTitle: "Hi" }).join(" ")).toMatch(/channelId/);
    expect(mod.validate({ channelId: "123" }).join(" ")).toMatch(/title or description/);
  });
  it("previews the embed from HTML", () => {
    const p = mod.preview({ channelId: "123", embedTitle: "Drop", embedDescription: "<b>Bold</b>", embedColor: "#ff0000" });
    expect(p.embed.title).toBe("Drop");
    expect(p.embed.description).toMatch(/\*\*Bold\*\*/);
  });
});

describe("forum_publish", () => {
  const mod = getActionModule("forum_publish");
  it("requires a valid discussionId", () => {
    expect(mod.validate({ discussionId: 5 })).toEqual([]);
    expect(mod.validate({ discussionId: 0 }).join(" ")).toMatch(/discussionId/);
  });
  it("describes", () => expect(mod.describe({ discussionId: 7 })).toMatch(/#7/));
});

describe("announcement_post", () => {
  const mod = getActionModule("announcement_post");
  it("requires postId and mode", () => {
    expect(mod.validate({ postId: 3, mode: "enable" })).toEqual([]);
    expect(mod.validate({ postId: 3, mode: "x" }).join(" ")).toMatch(/enable.*disable/);
    expect(mod.validate({ mode: "enable" }).join(" ")).toMatch(/postId/);
  });
  it("describes enable/disable", () => {
    expect(mod.describe({ postId: 3, mode: "disable" })).toMatch(/Disable/);
  });
});

describe("broadcast", () => {
  const mod = getActionModule("broadcast");
  it("requires a message", () => {
    expect(mod.validate({ message: "Server restarting" })).toEqual([]);
    expect(mod.validate({}).join(" ")).toMatch(/message is required/);
  });
  it("describes and previews", () => {
    expect(mod.describe({ message: "hi" })).toMatch(/hi/);
    expect(mod.preview({ message: "hi" }).sideEffects.join(" ")).toMatch(/alert hi/);
  });
});
