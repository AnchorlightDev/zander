import { describe, expect, it } from "vitest";
import {
  COOLDOWN_MS,
  RESERVATION_MS,
  cooldownRemainingMs,
  cooldownEndsAt,
  reservationExpiry,
  isReservationActive,
  resolveEffectiveNickname,
  checkImpersonation,
} from "../../lib/nicknames/nicknamePolicy.mjs";
import { buildSkeleton } from "../../lib/nicknames/nicknameValidation.mjs";

const NOW = new Date("2026-12-25T12:00:00Z").getTime();

describe("cooldown", () => {
  it("is zero when never set / cleared by staff (null)", () => {
    expect(cooldownRemainingMs(null, NOW)).toBe(0);
    expect(cooldownRemainingMs(undefined, NOW)).toBe(0);
    expect(cooldownEndsAt(null, NOW)).toBe(null);
  });

  it("blocks within 24h and reports remaining time", () => {
    const oneHourAgo = NOW - 60 * 60 * 1000;
    expect(cooldownRemainingMs(new Date(oneHourAgo), NOW)).toBe(COOLDOWN_MS - 60 * 60 * 1000);
    expect(cooldownEndsAt(new Date(oneHourAgo), NOW)).toBeInstanceOf(Date);
  });

  it("allows after 24h", () => {
    const exactly = NOW - COOLDOWN_MS;
    expect(cooldownRemainingMs(new Date(exactly), NOW)).toBe(0);
    expect(cooldownRemainingMs(new Date(exactly - 1), NOW)).toBe(0);
  });

  it("accepts ISO strings too", () => {
    const iso = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    expect(cooldownRemainingMs(iso, NOW)).toBe(COOLDOWN_MS - 2 * 60 * 60 * 1000);
  });
});

describe("reservations", () => {
  it("expires 14 days out", () => {
    expect(reservationExpiry(NOW).getTime()).toBe(NOW + RESERVATION_MS);
  });

  it("is active only while in the future", () => {
    expect(isReservationActive(new Date(NOW + 1000), NOW)).toBe(true);
    expect(isReservationActive(new Date(NOW - 1000), NOW)).toBe(false);
    expect(isReservationActive(null, NOW)).toBe(false);
  });
});

describe("resolveEffectiveNickname", () => {
  it("shows the nickname when the player holds the permission", () => {
    const r = resolveEffectiveNickname({
      username: "RealSteve",
      nicknameRow: { nickname: "JingleBelle", color: "gold" },
      holdsPermission: true,
    });
    expect(r).toEqual({
      display: "JingleBelle",
      nickname: "JingleBelle",
      color: "gold",
      isNick: true,
      hidden: false,
      realname: "RealSteve",
    });
  });

  it("hides the nickname (shows real name) when the permission lapsed", () => {
    const r = resolveEffectiveNickname({
      username: "RealSteve",
      nicknameRow: { nickname: "JingleBelle", color: "gold" },
      holdsPermission: false,
    });
    expect(r.display).toBe("RealSteve");
    expect(r.isNick).toBe(false);
    expect(r.hidden).toBe(true);
    expect(r.nickname).toBe(null);
  });

  it("returns real name with hidden=false when there is no nickname", () => {
    const r = resolveEffectiveNickname({
      username: "RealSteve",
      nicknameRow: null,
      holdsPermission: true,
    });
    expect(r.display).toBe("RealSteve");
    expect(r.hidden).toBe(false);
  });
});

describe("checkImpersonation", () => {
  const sk = buildSkeleton;
  const base = {
    ownUserId: 1,
    ownUsernameSkeleton: sk("SteveOwner"),
    usernameOwners: new Map(),
    nicknameOwners: new Map(),
    staffSkeletons: [],
  };

  it("allows a clean, unique nickname", () => {
    expect(checkImpersonation({ ...base, skeleton: sk("JingleBelle") })).toEqual({ ok: true });
  });

  it("allows a variant of the player's own username", () => {
    // different capitalisation -> same skeleton as own username
    expect(checkImpersonation({ ...base, skeleton: sk("steveOWNER") })).toEqual({ ok: true });
  });

  it("rejects another user's username", () => {
    const usernameOwners = new Map([[sk("Notch"), [2]]]);
    const r = checkImpersonation({ ...base, skeleton: sk("N0tch"), usernameOwners });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("impersonates_player");
  });

  it("does not reject the player's own username entry", () => {
    const usernameOwners = new Map([[sk("SteveOwner"), [1]]]);
    expect(checkImpersonation({ ...base, skeleton: sk("SteveOwner"), usernameOwners }).ok).toBe(true);
  });

  it("rejects another user's active/hidden/reserved nickname", () => {
    const nicknameOwners = new Map([[sk("Frosty"), [9]]]);
    const r = checkImpersonation({ ...base, skeleton: sk("Fr0sty"), nicknameOwners });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("reserved");
  });

  it("lets the owner reclaim their own reserved nickname", () => {
    const nicknameOwners = new Map([[sk("Frosty"), [1]]]);
    expect(checkImpersonation({ ...base, skeleton: sk("Frosty"), nicknameOwners }).ok).toBe(true);
  });

  it("rejects a name within edit distance 1 of a staff member", () => {
    const staffSkeletons = [sk("adminjane")];
    // "adminjam" -> skeleton within 1 of "adminjane"? use a 1-edit variant
    const r = checkImpersonation({ ...base, skeleton: sk("adminjan"), staffSkeletons });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("impersonates_player");
  });

  it("allows a name far from any staff member", () => {
    const staffSkeletons = [sk("adminjane")];
    expect(checkImpersonation({ ...base, skeleton: sk("Zorbon"), staffSkeletons }).ok).toBe(true);
  });

  it("rejects an empty skeleton", () => {
    expect(checkImpersonation({ ...base, skeleton: "" }).ok).toBe(false);
  });
});
