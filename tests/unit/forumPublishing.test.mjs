import { describe, expect, it } from "vitest";
import { resolvePublishState } from "../../lib/forumPublishing.mjs";

const NOW = new Date("2026-11-09T12:00:00Z");
const future = () => new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
const past = () => new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

describe("resolvePublishState", () => {
  it("publishes immediately for 'now' and for anything unrecognised", () => {
    expect(resolvePublishState({ mode: "now", now: NOW })).toEqual({ ok: true, status: "published", publishAt: null });
    expect(resolvePublishState({ mode: undefined, now: NOW }).status).toBe("published");
    expect(resolvePublishState({ mode: "weird", now: NOW }).status).toBe("published");
  });

  it("saves a draft without a publish time", () => {
    expect(resolvePublishState({ mode: "draft", now: NOW })).toEqual({ ok: true, status: "draft", publishAt: null });
  });

  it("refuses scheduling without the permission", () => {
    const r = resolvePublishState({ mode: "schedule", publishAt: future(), canSchedule: false, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission/i);
  });

  it("requires a valid future time to schedule", () => {
    expect(resolvePublishState({ mode: "schedule", publishAt: "", canSchedule: true, now: NOW }).ok).toBe(false);
    expect(resolvePublishState({ mode: "schedule", publishAt: "not-a-date", canSchedule: true, now: NOW }).ok).toBe(false);
    expect(resolvePublishState({ mode: "schedule", publishAt: past(), canSchedule: true, now: NOW }).ok).toBe(false);
  });

  it("schedules when permitted with a future time", () => {
    const when = future();
    const r = resolvePublishState({ mode: "schedule", publishAt: when, canSchedule: true, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("scheduled");
    expect(r.publishAt).toBeInstanceOf(Date);
    expect(r.publishAt.toISOString()).toBe(when);
  });
});
