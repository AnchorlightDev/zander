import { describe, it, expect, vi, beforeEach } from "vitest";

// A placeholder row's username is the person's self-chosen Discord handle, so
// it must never be used to look up a LuckPerms player -- otherwise anyone can
// copy a staff member's Minecraft name and inherit their rank roles.

const lpQuery = vi.fn();
const dbQuery = vi.fn();

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: (...args) => dbQuery(...args) },
  luckpermsDb: { query: (...args) => lpQuery(...args) },
}));
vi.mock("../../controllers/discordController.js", () => ({ client: {} }));

const { resolveLuckPermsUuid, syncMemberRankRoles } = await import("../../lib/discord/rankRoleSync.mjs");

const STAFF_UUID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  // Any username lookup "finds" the staff member's LuckPerms player.
  lpQuery.mockImplementation((sql, params, cb) =>
    cb(null, /LOWER\(username\)/.test(sql) ? [{ uuid: STAFF_UUID }] : [])
  );
});

describe("resolveLuckPermsUuid", () => {
  it("never resolves a placeholder through its (Discord) username", async () => {
    const uuid = await resolveLuckPermsUuid({ uuid: "random-uuid", username: "adminname", is_placeholder: 1 });
    expect(uuid).toBeNull();
    expect(lpQuery.mock.calls.some(([sql]) => /LOWER\(username\)/.test(sql))).toBe(false);
  });

  it("still falls back to username for a real linked account", async () => {
    const uuid = await resolveLuckPermsUuid({ uuid: null, username: "adminname", is_placeholder: 0 });
    expect(uuid).toBe(STAFF_UUID);
  });
});

describe("syncMemberRankRoles", () => {
  it("leaves a placeholder account's roles alone", async () => {
    dbQuery.mockImplementation((sql, params, cb) =>
      cb(null, [{ uuid: "random-uuid", username: "adminname", discordId: "999", is_placeholder: 1 }])
    );
    const result = await syncMemberRankRoles(42);
    expect(result).toMatchObject({ ok: false, reason: "PLACEHOLDER_ACCOUNT" });
    expect(lpQuery).not.toHaveBeenCalled();
  });
});
