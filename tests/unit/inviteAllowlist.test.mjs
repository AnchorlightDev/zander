import { describe, it, expect, vi } from "vitest";
import { cachedInviteResolver, stripOwnServerLinks } from "../../lib/discord/inviteAllowlist.mjs";

const OURS = "111111111111111111";
const THEIRS = "222222222222222222";
const invites = { ourcode: OURS, eventcode: OURS, theircode: THEIRS };
const resolveInviteGuildId = async (code) => invites[code] ?? null;
const strip = (content) => stripOwnServerLinks(content, { guildId: OURS, resolveInviteGuildId });

describe("stripOwnServerLinks", () => {
  it("removes invites to our own server, with or without https", async () => {
    expect(await strip("join discord.gg/ourcode now")).toBe("join now");
    expect(await strip("join https://discord.com/invite/ourcode now")).toBe("join now");
  });

  it("removes our event invites and event links", async () => {
    expect(await strip("event: discord.gg/eventcode?event=123456789012345678")).toBe("event:");
    expect(await strip(`see https://discord.com/events/${OURS}/333333333333333333`)).toBe("see");
  });

  it("removes links to messages in our server", async () => {
    expect(await strip(`look https://discord.com/channels/${OURS}/1/2`)).toBe("look");
  });

  it("keeps other servers' invites and event links so the filter still catches them", async () => {
    expect(await strip("join discord.gg/theircode")).toBe("join discord.gg/theircode");
    expect(await strip(`https://discord.com/events/${THEIRS}/3`)).toBe(`https://discord.com/events/${THEIRS}/3`);
  });

  it("keeps invites it cannot resolve", async () => {
    expect(await strip("discord.gg/unknown")).toBe("discord.gg/unknown");
    const failing = () => Promise.reject(new Error("rate limited"));
    expect(await stripOwnServerLinks("discord.gg/ourcode", { guildId: OURS, resolveInviteGuildId: failing })).toBe(
      "discord.gg/ourcode"
    );
  });

  it("strips only our link from a mixed message", async () => {
    expect(await strip("ours discord.gg/ourcode theirs discord.gg/theircode")).toBe("ours theirs discord.gg/theircode");
  });
});

describe("cachedInviteResolver", () => {
  it("looks each code up once while cached", async () => {
    const lookup = vi.fn(async () => OURS);
    const resolve = cachedInviteResolver(lookup);
    await resolve("abc");
    await resolve("abc");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("caches misses for a shorter time and treats errors as unknown", async () => {
    let t = 0;
    const lookup = vi.fn(async () => { throw new Error("nope"); });
    const resolve = cachedInviteResolver(lookup, { missTtlMs: 100, ttlMs: 1000, now: () => t });
    expect(await resolve("bad")).toBeNull();
    t = 50;
    await resolve("bad");
    expect(lookup).toHaveBeenCalledTimes(1);
    t = 200;
    await resolve("bad");
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
