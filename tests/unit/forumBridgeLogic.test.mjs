import { describe, expect, it } from "vitest";
import {
  DISCORD_MESSAGE_LIMIT,
  OUTBOX_ACTIONS,
  attachmentsToHtml,
  createDmThrottle,
  discordMarkdownToHtml,
  formatWebPostForDiscord,
  isEffectivelyEmpty,
  nextAttemptDelayMs,
  planOutboxTasks,
  toThreadName,
  toWebhookUsername,
} from "../../lib/forums/forumBridgeLogic.mjs";
import { FORUM_EVENTS, ORIGIN } from "../../lib/forums/forumEvents.mjs";

const bridgedCtx = (ids = [1]) => ({ isBridged: (categoryId) => ids.includes(Number(categoryId)) });

describe("planOutboxTasks", () => {
  it("creates a Discord post for a new discussion in a bridged category", () => {
    const tasks = planOutboxTasks(FORUM_EVENTS.DISCUSSION_CREATED, { discussionId: 5, categoryId: 1, origin: ORIGIN.WEB }, bridgedCtx());
    expect(tasks).toEqual([{ action: OUTBOX_ACTIONS.CREATE_THREAD, discussionId: 5 }]);
  });

  it("ignores categories that are not bridged", () => {
    expect(planOutboxTasks(FORUM_EVENTS.DISCUSSION_CREATED, { discussionId: 5, categoryId: 2 }, bridgedCtx())).toEqual([]);
  });

  it("never echoes changes that came from Discord", () => {
    for (const name of Object.values(FORUM_EVENTS)) {
      expect(planOutboxTasks(name, { discussionId: 5, categoryId: 1, postId: 9, origin: ORIGIN.DISCORD, discordThreadId: "1", discordMessageId: "2", fromCategoryId: 1 }, bridgedCtx())).toEqual([]);
    }
  });

  it("renames and edits separately on a discussion update", () => {
    const tasks = planOutboxTasks(
      FORUM_EVENTS.DISCUSSION_UPDATED,
      { discussionId: 5, categoryId: 1, titleChanged: true, contentChanged: true },
      bridgedCtx()
    );
    expect(tasks.map((t) => t.action)).toEqual([OUTBOX_ACTIONS.RENAME_THREAD, OUTBOX_ACTIONS.EDIT_STARTER]);
  });

  it("carries lock/archive state", () => {
    const [task] = planOutboxTasks(FORUM_EVENTS.DISCUSSION_FLAGS, { discussionId: 5, categoryId: 1, isLocked: false, isArchived: true }, bridgedCtx());
    expect(task).toMatchObject({ action: OUTBOX_ACTIONS.SET_THREAD_STATE, payload: { isLocked: false, isArchived: true } });
  });

  it("deletes the Discord post when a discussion with one is deleted", () => {
    const [task] = planOutboxTasks(FORUM_EVENTS.DISCUSSION_DELETED, { discussionId: 5, categoryId: 1, discordThreadId: "123" }, bridgedCtx([]));
    expect(task).toEqual({ action: OUTBOX_ACTIONS.DELETE_THREAD, discussionId: null, payload: { threadId: "123" } });
  });

  it("closes the Discord post when a discussion leaves a bridged category", () => {
    const tasks = planOutboxTasks(
      FORUM_EVENTS.DISCUSSION_MOVED,
      { discussionId: 5, fromCategoryId: 1, toCategoryId: 3, discordThreadId: "123" },
      bridgedCtx()
    );
    expect(tasks[0].action).toBe(OUTBOX_ACTIONS.CLOSE_MOVED_THREAD);
    expect(planOutboxTasks(FORUM_EVENTS.DISCUSSION_MOVED, { discussionId: 5, fromCategoryId: 3, toCategoryId: 1, discordThreadId: null }, bridgedCtx())).toEqual([]);
  });

  it("maps replies, starter edits and deletes", () => {
    const ctx = { ...bridgedCtx(), categoryId: 1 };
    expect(planOutboxTasks(FORUM_EVENTS.POST_CREATED, { postId: 9, discussionId: 5 }, ctx)[0].action).toBe(OUTBOX_ACTIONS.CREATE_MESSAGE);
    expect(planOutboxTasks(FORUM_EVENTS.POST_UPDATED, { postId: 9, discussionId: 5, isOriginal: true }, ctx)[0].action).toBe(OUTBOX_ACTIONS.EDIT_STARTER);
    expect(planOutboxTasks(FORUM_EVENTS.POST_UPDATED, { postId: 9, discussionId: 5, isOriginal: false }, ctx)[0].action).toBe(OUTBOX_ACTIONS.EDIT_MESSAGE);
    expect(planOutboxTasks(FORUM_EVENTS.POST_DELETED, { postId: 9, discussionId: 5, discordMessageId: "77" }, ctx)[0]).toMatchObject({
      action: OUTBOX_ACTIONS.DELETE_MESSAGE,
      payload: { messageId: "77" },
    });
    expect(planOutboxTasks(FORUM_EVENTS.POST_DELETED, { postId: 9, discussionId: 5, discordMessageId: null }, ctx)).toEqual([]);
  });

  it("syncs website reactions", () => {
    const [task] = planOutboxTasks(FORUM_EVENTS.REACTION_CHANGED, { postId: 9, emoji: "👍" }, { ...bridgedCtx(), categoryId: 1, discussionId: 5 });
    expect(task).toMatchObject({ action: OUTBOX_ACTIONS.SYNC_REACTION, postId: 9, payload: { emoji: "👍" } });
  });
});

describe("Discord limits and naming", () => {
  it("clamps thread names to 100 characters", () => {
    expect(toThreadName("a".repeat(150))).toHaveLength(100);
    expect(toThreadName("   ")).toBe("Discussion");
  });

  it("keeps webhook usernames Discord will accept", () => {
    expect(toWebhookUsername("DiscordFan")).not.toMatch(/discord/i);
    expect(toWebhookUsername("clyde_1")).not.toMatch(/clyde/i);
    expect(toWebhookUsername("")).toBe("Player");
  });

  it("backs off exponentially, capped at an hour", () => {
    expect(nextAttemptDelayMs(1)).toBe(30_000);
    expect(nextAttemptDelayMs(2)).toBe(60_000);
    expect(nextAttemptDelayMs(20)).toBe(60 * 60_000);
  });
});

describe("formatWebPostForDiscord", () => {
  it("converts HTML, keeps images visible and defuses mass mentions", () => {
    const out = formatWebPostForDiscord('<p>Hi <strong>all</strong> @everyone</p><img src="https://img.example/a.png">');
    expect(out).toContain("**all**");
    expect(out).toContain("https://img.example/a.png");
    expect(out).not.toMatch(/@everyone/);
  });

  it("adds reply context", () => {
    const out = formatWebPostForDiscord("<p>yes</p>", { replyToUsername: "Bob", replyToUrl: "https://x/y" });
    expect(out.split("\n")[0]).toContain("Replying to **Bob**");
  });

  it("stays within Discord's message limit and links to the rest", () => {
    const out = formatWebPostForDiscord(`<p>${"word ".repeat(1500)}</p>`, { postUrl: "https://site/forums/discussion/1" });
    expect(out.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(out).toContain("Read the rest on the website");
  });
});

describe("discordMarkdownToHtml", () => {
  it("escapes HTML so Discord text can't inject markup", () => {
    const html = discordMarkdownToHtml('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("maps common Discord markdown", () => {
    const html = discordMarkdownToHtml("**bold** *it* __under__ ~~gone~~ `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<u>under</u>");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain("<code>code</code>");
  });

  it("keeps code blocks verbatim and escaped", () => {
    const html = discordMarkdownToHtml("```js\nconst a = '<b>**x**</b>';\n```");
    expect(html).toBe("<pre><code>const a = &#39;&lt;b&gt;**x**&lt;/b&gt;&#39;;</code></pre>");
  });

  it("resolves mentions and renders custom emoji", () => {
    const html = discordMarkdownToHtml("hi <@123456789012345678> in <#223456789012345678> <:pepe:323456789012345678>", {
      resolveUser: () => "Adam",
      resolveChannel: () => "shopping-district",
    });
    expect(html).toContain("@Adam");
    expect(html).toContain("#shopping-district");
    expect(html).toContain("cdn.discordapp.com/emojis/323456789012345678");
  });

  it("links URLs and masked links but not unsafe schemes", () => {
    const html = discordMarkdownToHtml("see https://example.com/a?b=1 and [docs](https://docs.example) and [bad](javascript:alert(1))");
    expect(html).toContain('<a href="https://example.com/a?b=1">');
    expect(html).toContain('<a href="https://docs.example">docs</a>');
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("does not italicise underscores inside names", () => {
    expect(discordMarkdownToHtml("what_am_i_doing9")).toBe("<p>what_am_i_doing9</p>");
  });

  it("builds lists and quotes", () => {
    const html = discordMarkdownToHtml("> quoted\n- one\n- two\n1. first");
    expect(html).toContain("<blockquote>quoted</blockquote>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li></ol>");
  });
});

describe("attachments and emptiness", () => {
  it("shows re-hosted images inline and other files as links", () => {
    const html = attachmentsToHtml(
      [
        { id: "1", name: "shop.png", url: "https://cdn.discordapp.com/a.png", contentType: "image/png" },
        { id: "2", name: "list.txt", url: "https://cdn.discordapp.com/b.txt", contentType: "text/plain" },
      ],
      new Map([["1", "https://res.cloudinary.com/x/shop.png"]])
    );
    expect(html).toContain('<img src="https://res.cloudinary.com/x/shop.png"');
    expect(html).toContain('href="https://cdn.discordapp.com/b.txt"');
  });

  it("detects empty content", () => {
    expect(isEffectivelyEmpty("<p> </p>")).toBe(true);
    expect(isEffectivelyEmpty('<p><img src="https://x/y.png"></p>')).toBe(false);
  });
});

describe("createDmThrottle", () => {
  it("allows one DM per user per window", () => {
    let t = 0;
    const shouldSend = createDmThrottle(1000, () => t);
    expect(shouldSend("a")).toBe(true);
    expect(shouldSend("a")).toBe(false);
    expect(shouldSend("b")).toBe(true);
    t = 1500;
    expect(shouldSend("a")).toBe(true);
  });
});
