import { describe, expect, it } from "vitest";
import {
  setNickname,
  clearNickname,
  resolveNickname,
  staffResetNickname,
} from "../../controllers/nicknameController.js";
import { DEFAULT_RANK_WORDS, buildSkeleton } from "../../lib/nicknames/nicknameValidation.mjs";

const NOW = new Date("2026-12-25T12:00:00Z").getTime();
const USER = { userId: 1, uuid: "11111111-1111-1111-1111-111111111111", username: "SteveReal" };

function makeDeps(overrides = {}) {
  const calls = { persistSet: [], persistClear: [], log: [] };
  const deps = {
    now: () => NOW,
    resolveUser: async () => ({ ...USER }),
    getPermissions: async () => ["zander.nickname"],
    isPunished: async () => false,
    getLockout: async () => null,
    getNicknameRow: async () => null,
    getBlocklist: async () => ({ bannedWords: ["shit", "noob"], rankWords: DEFAULT_RANK_WORDS }),
    getReference: async ({ username }) => ({
      ownUsernameSkeleton: buildSkeleton(username),
      usernameOwners: new Map(),
      nicknameOwners: new Map(),
      staffSkeletons: [],
    }),
    persistSet: async (a) => calls.persistSet.push(a),
    persistClear: async (a) => calls.persistClear.push(a),
    log: async (...a) => calls.log.push(a),
    ...overrides,
  };
  return { deps, calls };
}

describe("setNickname gates", () => {
  it("rejects a player without the permission (covers lapsed support)", async () => {
    const { deps, calls } = makeDeps({ getPermissions: async () => [] });
    const r = await setNickname({ uuid: USER.uuid }, { name: "JingleBelle" }, deps);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no_permission");
    expect(calls.persistSet).toHaveLength(0);
  });

  it("rejects a locked-out player", async () => {
    const { deps } = makeDeps({ getLockout: async () => ({ reason: "spam", expiresAt: null }) });
    const r = await setNickname({ uuid: USER.uuid }, { name: "JingleBelle" }, deps);
    expect(r.code).toBe("locked");
    expect(r.reason).toBe("spam");
  });

  it("rejects a muted/banned player", async () => {
    const { deps } = makeDeps({ isPunished: async () => true });
    const r = await setNickname({ uuid: USER.uuid }, { name: "JingleBelle" }, deps);
    expect(r.code).toBe("punished");
  });

  it("enforces the 24h cooldown", async () => {
    const { deps } = makeDeps({
      getNicknameRow: async () => ({
        nickname: "OldName",
        skeleton: buildSkeleton("OldName"),
        color: null,
        lastChangeAt: new Date(NOW - 60 * 60 * 1000), // 1h ago
      }),
    });
    const r = await setNickname({ uuid: USER.uuid }, { name: "BrandNew" }, deps);
    expect(r.code).toBe("cooldown");
    expect(r.remainingMs).toBeGreaterThan(0);
  });

  it("rejects a banned word", async () => {
    const { deps } = makeDeps();
    const r = await setNickname({ uuid: USER.uuid }, { name: "lilsh1t" }, deps);
    expect(r.code).toBe("blocked_word");
  });

  it("rejects impersonating another player's username", async () => {
    const { deps } = makeDeps({
      getReference: async ({ username, skeleton }) => ({
        ownUsernameSkeleton: buildSkeleton(username),
        usernameOwners: new Map([[skeleton, [2]]]),
        nicknameOwners: new Map(),
        staffSkeletons: [],
      }),
    });
    const r = await setNickname({ uuid: USER.uuid }, { name: "Notch" }, deps);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("impersonates_player");
  });

  it("rejects a colour without the colour permission", async () => {
    const { deps } = makeDeps();
    const r = await setNickname({ uuid: USER.uuid }, { name: "CleanName", color: "gold" }, deps);
    expect(r.code).toBe("color_not_allowed");
  });

  it("allows a colour with the colour permission", async () => {
    const { deps, calls } = makeDeps({
      getPermissions: async () => ["zander.nickname", "zander.nickname.color"],
    });
    const r = await setNickname({ uuid: USER.uuid }, { name: "CleanName", color: "gold" }, deps);
    expect(r.ok).toBe(true);
    expect(r.color).toBe("gold");
    expect(calls.persistSet[0].color).toBe("gold");
  });

  it("allows a variant of the player's own username even if it maps to them", async () => {
    const { deps } = makeDeps({
      getReference: async ({ username, skeleton }) => ({
        ownUsernameSkeleton: buildSkeleton(username),
        usernameOwners: new Map([[skeleton, [1]]]),
        nicknameOwners: new Map(),
        staffSkeletons: [],
      }),
    });
    const r = await setNickname({ uuid: USER.uuid }, { name: "stevereal" }, deps);
    expect(r.ok).toBe(true);
  });

  it("succeeds on a clean nickname and audit-logs it", async () => {
    const { deps, calls } = makeDeps();
    const r = await setNickname({ uuid: USER.uuid }, { name: "JingleBelle" }, deps);
    expect(r.ok).toBe(true);
    expect(r.nickname).toBe("JingleBelle");
    expect(calls.persistSet).toHaveLength(1);
    expect(calls.log[0][1]).toBe("NICKNAME_SET");
  });

  it("passes the previous nickname through so it gets the 14-day hold", async () => {
    const previous = {
      nickname: "OldName",
      skeleton: buildSkeleton("OldName"),
      color: null,
      lastChangeAt: new Date(NOW - 48 * 60 * 60 * 1000), // 2 days ago, past cooldown
    };
    const { deps, calls } = makeDeps({ getNicknameRow: async () => previous });
    const r = await setNickname({ uuid: USER.uuid }, { name: "BrandNew" }, deps);
    expect(r.ok).toBe(true);
    expect(calls.persistSet[0].previous).toBe(previous);
  });
});

describe("clearNickname", () => {
  it("clears an existing nickname with a self-hold and audit log", async () => {
    const { deps, calls } = makeDeps({
      getNicknameRow: async () => ({ nickname: "OldName", skeleton: buildSkeleton("OldName") }),
    });
    const r = await clearNickname({ uuid: USER.uuid }, deps);
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(true);
    expect(calls.persistClear[0].byStaff).toBe(false);
    expect(calls.log[0][1]).toBe("NICKNAME_CLEARED");
  });

  it("is a no-op when there is no nickname", async () => {
    const { deps, calls } = makeDeps({ getNicknameRow: async () => null });
    const r = await clearNickname({ uuid: USER.uuid }, deps);
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(false);
    expect(calls.persistClear).toHaveLength(0);
  });
});

describe("staffResetNickname", () => {
  it("clears without a hold (byStaff) and logs the reset", async () => {
    const { deps, calls } = makeDeps({
      getNicknameRow: async () => ({ nickname: "BadNick", skeleton: buildSkeleton("BadNick") }),
    });
    const r = await staffResetNickname({ userId: 1 }, 99, deps);
    expect(r.ok).toBe(true);
    expect(calls.persistClear[0].byStaff).toBe(true);
    expect(calls.log[0][0]).toBe(99);
    expect(calls.log[0][1]).toBe("NICKNAME_RESET");
  });
});

describe("resolveNickname (lapse and return)", () => {
  it("hides the nickname and shows the real name when the permission lapsed", async () => {
    const { deps } = makeDeps({
      getPermissions: async () => [],
      getNicknameRow: async () => ({ nickname: "JingleBelle", color: "gold" }),
    });
    const r = await resolveNickname({ uuid: USER.uuid }, deps);
    expect(r.display).toBe("SteveReal");
    expect(r.isNick).toBe(false);
    expect(r.hidden).toBe(true);
    expect(r.nickname).toBe(null);
  });

  it("returns the nickname automatically when the permission is held again", async () => {
    const { deps } = makeDeps({
      getPermissions: async () => ["zander.nickname"],
      getNicknameRow: async () => ({ nickname: "JingleBelle", color: "gold" }),
    });
    const r = await resolveNickname({ uuid: USER.uuid }, deps);
    expect(r.display).toBe("JingleBelle");
    expect(r.isNick).toBe(true);
    expect(r.color).toBe("gold");
  });
});
