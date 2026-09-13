import { describe, it, expect } from "vitest";
import { formatDiscordTimestamp } from "../../lib/discord/discordFormatting.mjs";

describe("formatDiscordTimestamp", () => {
  it("returns fallback for null", () => {
    expect(formatDiscordTimestamp(null)).toBe("No record");
  });

  it("returns fallback for undefined", () => {
    expect(formatDiscordTimestamp(undefined)).toBe("No record");
  });

  it("returns custom fallback when provided", () => {
    expect(formatDiscordTimestamp(null, { fallback: "Never" })).toBe("Never");
  });

  it("returns fallback for empty string", () => {
    expect(formatDiscordTimestamp("")).toBe("No record");
  });

  it("returns fallback for all-zero date string", () => {
    expect(formatDiscordTimestamp("0000-00-00 00:00:00")).toBe("No record");
  });

  it("formats a Date object correctly", () => {
    const d = new Date("2024-01-15T12:00:00Z");
    const ts = Math.floor(d.getTime() / 1000);
    const result = formatDiscordTimestamp(d);
    expect(result).toContain(`<t:${ts}:D>`);
    expect(result).toContain(`<t:${ts}:R>`);
  });

  it("formats a unix timestamp in seconds", () => {
    const ts = 1705320000;
    const result = formatDiscordTimestamp(ts);
    expect(result).toContain(`<t:${ts}:D>`);
  });

  it("formats a unix timestamp in milliseconds", () => {
    const ms = 1705320000000;
    const ts = Math.floor(ms / 1000);
    const result = formatDiscordTimestamp(ms);
    expect(result).toContain(`<t:${ts}:D>`);
  });

  it("formats a MySQL datetime string", () => {
    const result = formatDiscordTimestamp("2024-01-15 12:00:00");
    expect(result).toMatch(/^<t:\d+:D> \(<t:\d+:R>\)$/);
  });

  it("formats an ISO string", () => {
    const result = formatDiscordTimestamp("2024-01-15T12:00:00Z");
    expect(result).toMatch(/^<t:\d+:D> \(<t:\d+:R>\)$/);
  });

  it("respects dateStyle option", () => {
    const d = new Date("2024-01-15T12:00:00Z");
    const ts = Math.floor(d.getTime() / 1000);
    expect(formatDiscordTimestamp(d, { dateStyle: "F" })).toContain(`<t:${ts}:F>`);
  });

  it("omits relative timestamp when includeRelative is false", () => {
    const d = new Date("2024-01-15T12:00:00Z");
    const ts = Math.floor(d.getTime() / 1000);
    const result = formatDiscordTimestamp(d, { includeRelative: false });
    expect(result).toBe(`<t:${ts}:D>`);
    expect(result).not.toContain(":R>");
  });

  it("returns fallback for invalid date string", () => {
    expect(formatDiscordTimestamp("not-a-date")).toBe("No record");
  });
});
