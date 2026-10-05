import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import ejs from "ejs";
import { homepageCategoryIds } from "../../lib/homepageForum.js";
import { plainTextExcerpt } from "../../lib/htmlSanitize.js";

// Shaped like getCategoriesForUser(): `flat` holds only what the visitor can see
const news = { categoryId: 1, slug: "network-announcements", isAccessible: true, children: [] };
const patchNotes = { categoryId: 2, slug: "patch-notes", isAccessible: true, children: [] };
const staffOnly = { categoryId: 3, slug: "staff-notes", isAccessible: false, children: [] };
news.children = [patchNotes, staffOnly];
const general = { categoryId: 4, slug: "general", isAccessible: true, children: [] };
const visible = { flat: [news, patchNotes, general] };

describe("homepageCategoryIds", () => {
  it("uses every visible category when no slug is set", () => {
    expect(homepageCategoryIds(visible, "")).toEqual([1, 2, 4]);
  });

  it("uses the chosen category and its visible subcategories", () => {
    expect(homepageCategoryIds(visible, "Network-Announcements")).toEqual([1, 2]);
  });

  it("shows nothing when the chosen category is hidden from the visitor", () => {
    // A visitor who cannot see it -- e.g. logged out -- must not get a fallback
    expect(homepageCategoryIds({ flat: [general] }, "network-announcements")).toEqual([]);
    expect(homepageCategoryIds(visible, "does-not-exist")).toEqual([]);
  });
});

describe("plainTextExcerpt", () => {
  it("strips tags, keeps words apart and decodes entities", () => {
    expect(plainTextExcerpt("<p>Server&nbsp;update</p><p>Tom &amp; Jerry&#39;s <b>build</b></p>"))
      .toBe("Server update Tom & Jerry's build");
  });

  it("cuts long text at a word boundary", () => {
    const out = plainTextExcerpt("<p>" + "word ".repeat(60) + "</p>", 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith("word…")).toBe(true);
  });

  it("drops scripts entirely", () => {
    expect(plainTextExcerpt('<p>Hi</p><script>alert(1)</script>')).toBe("Hi");
  });
});

describe("latestForumPosts partial", () => {
  const file = path.resolve("views/modules/index/latestForumPosts.ejs");
  const render = (forumPosts) => ejs.render(fs.readFileSync(file, "utf8"), { forumPosts }, { filename: file });

  it("links each discussion and escapes its text", () => {
    const html = render({
      title: "Network Announcements",
      viewAllUrl: "/forums/category/network-announcements",
      discussions: [{
        discussionId: 9, slug: "season-3", title: "Season 3 <launch>", categoryName: "Network Announcements",
        categorySlug: "network-announcements", excerpt: "It's <here>", replyCount: 2,
        createdAt: new Date("2026-10-01T00:00:00Z"), author: { username: "Ben", avatarUrl: null },
      }],
    });
    expect(html).toContain('href="/forums/discussion/9/season-3"');
    expect(html).toContain("Season 3 &lt;launch&gt;");
    expect(html).toContain("It&#39;s &lt;here&gt;");
    expect(html).toContain('href="/forums/category/network-announcements"');
  });
});

describe("getLatestDiscussions", () => {
  it("returns the newest, non-archived discussions with an excerpt of the opening post", async () => {
    const { vi } = await import("vitest");
    const calls = [];
    const answers = [
      [ // discussions
        { discussionId: 5, categoryId: 1, title: "B", slug: "b", createdBy: 7, createdAt: new Date("2026-10-02"),
          isLocked: 0, isSticky: 0, isArchived: 0, categoryName: "News", categorySlug: "news" },
      ],
      [{ discussionId: 5, postCount: 3 }], // post counts
      [ // posts, opening post first
        { discussionId: 5, content: "<p>Opening &amp; first</p>" },
        { discussionId: 5, content: "<p>a reply</p>" },
      ],
      [{ userId: 7, username: "Ben", uuid: "abc", profilePicture_type: "CRAFTATAR" }], // users
    ];
    vi.resetModules();
    vi.doMock("../../controllers/databaseController.js", () => ({
      default: { query: (sql, params, cb) => { calls.push({ sql, params }); cb(null, answers.shift() || []); } },
      luckpermsDb: { query: (sql, params, cb) => cb(null, []) },
    }));
    const { getLatestDiscussions } = await import("../../controllers/forumController.js");

    const [d] = await getLatestDiscussions({ categoryIds: [1, 2], limit: 4 });

    expect(calls[0].sql).toMatch(/isArchived = 0/);
    expect(calls[0].sql).toMatch(/ORDER BY d\.createdAt DESC/);
    expect(calls[0].sql).not.toMatch(/isSticky DESC/);
    expect(calls[0].params).toEqual([1, 2, 4]);
    expect(d).toMatchObject({ discussionId: 5, replyCount: 2, excerpt: "Opening & first", categorySlug: "news" });
    expect(d.author.username).toBe("Ben");
    vi.doUnmock("../../controllers/databaseController.js");
  });

  it("does not query at all when the visitor can see no categories", async () => {
    const { getLatestDiscussions } = await import("../../controllers/forumController.js");
    expect(await getLatestDiscussions({ categoryIds: [] })).toEqual([]);
  });
});
