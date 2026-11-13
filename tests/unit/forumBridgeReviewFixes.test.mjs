import { describe, expect, it } from "vitest";
import {
  FORUM_MODERATE_PERMISSION,
  attachmentsToHtml,
  bridgeCheckNeedsPermissions,
  bridgeParticipationRefusal,
  discordMessageContentChanged,
  reusableHostedUrls,
} from "../../lib/forums/forumBridgeLogic.mjs";
import { sanitizeForumHtml } from "../../lib/htmlSanitize.js";

// Same shape as forumController.permissionMatch, enough for these checks.
const matches = (permissions, node) =>
  !node || permissions.some((p) => p === "*" || p === node || (p.endsWith(".*") && node.startsWith(p.slice(0, -1))));

describe("bridgeParticipationRefusal", () => {
  const donorBridge = { viewPermission: "zander.donator", postPermission: null };

  it("refuses replies, posts and reactions in a category the member cannot view", () => {
    for (const action of ["start", "reply", "react"]) {
      expect(
        bridgeParticipationRefusal({ permissions: ["@authenticated"], bridge: donorBridge, action, matches })
      ).toBe("view");
    }
    expect(
      bridgeParticipationRefusal({ permissions: ["@authenticated", "zander.donator"], bridge: donorBridge, action: "reply", matches })
    ).toBeNull();
  });

  it("treats @authenticated as satisfied for any linked member", () => {
    const bridge = { viewPermission: "@authenticated" };
    expect(bridgeParticipationRefusal({ permissions: ["@authenticated"], bridge, action: "reply", matches })).toBeNull();
  });

  it("keeps the post permission for new posts only", () => {
    const bridge = { postPermission: "zander.forums.announce" };
    expect(bridgeParticipationRefusal({ permissions: ["@authenticated"], bridge, action: "start", matches })).toBe("permission");
    expect(bridgeParticipationRefusal({ permissions: ["@authenticated"], bridge, action: "reply", matches })).toBeNull();
  });

  it("refuses replies to locked or archived discussions except from moderators", () => {
    const bridge = {};
    for (const discussion of [{ isLocked: true }, { isArchived: true }]) {
      expect(bridgeParticipationRefusal({ permissions: ["@authenticated"], bridge, action: "reply", discussion, matches })).toBe("closed");
      expect(
        bridgeParticipationRefusal({ permissions: [FORUM_MODERATE_PERMISSION], bridge, action: "reply", discussion, matches })
      ).toBeNull();
    }
    expect(
      bridgeParticipationRefusal({ permissions: [], bridge, action: "reply", discussion: { isLocked: false, isArchived: false }, matches })
    ).toBeNull();
  });

  it("only loads permissions when a check can fail", () => {
    expect(bridgeCheckNeedsPermissions({ bridge: {}, action: "reply", discussion: {} })).toBe(false);
    expect(bridgeCheckNeedsPermissions({ bridge: {}, action: "react" })).toBe(false);
    expect(bridgeCheckNeedsPermissions({ bridge: { viewPermission: "x" }, action: "react" })).toBe(true);
    expect(bridgeCheckNeedsPermissions({ bridge: { postPermission: "x" }, action: "start" })).toBe(true);
    expect(bridgeCheckNeedsPermissions({ bridge: {}, action: "reply", discussion: { isArchived: true } })).toBe(true);
  });
});

describe("discordMessageContentChanged", () => {
  const coll = (...ids) => new Map(ids.map((id) => [id, {}]));
  const msg = (content, attachments = coll(), stickers = coll()) => ({ content, attachments, stickers });

  it("ignores updates that change nothing the website shows (embeds, pins)", () => {
    expect(discordMessageContentChanged(msg("hi", coll("a1")), msg("hi", coll("a1")))).toBe(false);
  });

  it("notices text and attachment changes", () => {
    expect(discordMessageContentChanged(msg("hi"), msg("hello"))).toBe(true);
    expect(discordMessageContentChanged(msg("hi", coll("a1", "a2")), msg("hi", coll("a1")))).toBe(true);
  });

  it("cannot tell when the old message was not cached", () => {
    expect(discordMessageContentChanged({ partial: true, content: null }, msg("hi"))).toBeNull();
    expect(discordMessageContentChanged(null, msg("hi"))).toBeNull();
  });
});

describe("reusableHostedUrls", () => {
  it("reuses images already re-hosted for the message instead of uploading again", () => {
    const attachments = [
      { id: "1", name: "cat & dog.png", contentType: "image/png" },
      { id: "2", name: "shot.png", contentType: "image/png" },
    ];
    const hosted = new Map([
      ["1", "https://res.cloudinary.com/x/a.png"],
      ["2", "https://res.cloudinary.com/x/b.png"],
    ]);
    const stored = sanitizeForumHtml(`<p>text</p>${attachmentsToHtml(attachments, hosted)}`);
    const reused = reusableHostedUrls(stored, attachments);
    expect(reused).toEqual(hosted);
    // Rebuilding with the reused URLs gives identical HTML, so no new revision.
    expect(sanitizeForumHtml(`<p>text</p>${attachmentsToHtml(attachments, reused)}`)).toBe(stored);
  });

  it("never reuses expiring Discord CDN links and skips new attachments", () => {
    const stored = '<p><img src="https://cdn.discordapp.com/attachments/1/2/a.png" alt="a.png" /></p>';
    expect(reusableHostedUrls(stored, [{ id: "1", name: "a.png" }]).size).toBe(0);
    expect(reusableHostedUrls("<p>no images</p>", [{ id: "1", name: "a.png" }]).size).toBe(0);
  });
});
