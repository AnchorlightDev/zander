import { describe, it, expect } from "vitest";
import { resolveDiscordLinkConflict } from "../../controllers/userController.js";

describe("resolveDiscordLinkConflict", () => {
  it("does nothing when no other row holds the Discord account", () => {
    expect(resolveDiscordLinkConflict(null, 20)).toBe("none");
    expect(resolveDiscordLinkConflict(undefined, 20)).toBe("none");
  });

  it("does nothing when the link already belongs to this account", () => {
    expect(resolveDiscordLinkConflict({ userId: 20, is_placeholder: 0 }, 20)).toBe("none");
  });

  it("absorbs a placeholder row — it is the same person, not a rival account", () => {
    expect(resolveDiscordLinkConflict({ userId: 10, is_placeholder: 1 }, 20)).toBe("absorb");
  });

  it("refuses when a real account holds the link, so a link cannot take an account over", () => {
    expect(resolveDiscordLinkConflict({ userId: 10, is_placeholder: 0 }, 20)).toBe("refuse");
  });

  it("treats a falsy placeholder flag as a real account", () => {
    expect(resolveDiscordLinkConflict({ userId: 10 }, 20)).toBe("refuse");
    expect(resolveDiscordLinkConflict({ userId: 10, is_placeholder: null }, 20)).toBe("refuse");
  });
});
