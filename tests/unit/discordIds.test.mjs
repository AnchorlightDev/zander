/**
 * tests/unit/discordIds.test.mjs
 *
 * Parsing the per-form list of people to DM. Typed by hand into a dashboard
 * textarea, so it arrives in whatever shape the admin felt like.
 */

import { describe, expect, it } from "vitest";
import { formatDiscordIds, parseDiscordId, parseDiscordIds } from "../../lib/discordIds.mjs";

const A = "112233445566778899";
const B = "998877665544332211";

describe("parseDiscordId", () => {
  it("accepts a plain snowflake", () => {
    expect(parseDiscordId(A)).toBe(A);
    expect(parseDiscordId(`  ${A}  `)).toBe(A);
  });

  it("accepts a pasted mention, which is what you get without Copy User ID", () => {
    expect(parseDiscordId(`<@${A}>`)).toBe(A);
    expect(parseDiscordId(`<@!${A}>`)).toBe(A);
  });

  it("rejects anything that is not a plausible snowflake", () => {
    expect(parseDiscordId("123")).toBeNull();
    expect(parseDiscordId("not-an-id")).toBeNull();
    expect(parseDiscordId("")).toBeNull();
    expect(parseDiscordId(null)).toBeNull();
    expect(parseDiscordId("1".repeat(25))).toBeNull();
    expect(parseDiscordId("11223344556677889a")).toBeNull();
  });
});

describe("parseDiscordIds", () => {
  it("is empty for nothing", () => {
    expect(parseDiscordIds(null)).toEqual([]);
    expect(parseDiscordIds("")).toEqual([]);
    expect(parseDiscordIds("   ")).toEqual([]);
    expect(parseDiscordIds(undefined)).toEqual([]);
  });

  it("splits on newlines, commas and spaces alike", () => {
    expect(parseDiscordIds(`${A}\n${B}`)).toEqual([A, B]);
    expect(parseDiscordIds(`${A}, ${B}`)).toEqual([A, B]);
    expect(parseDiscordIds(`${A} ${B}`)).toEqual([A, B]);
    expect(parseDiscordIds(`${A},\n  ${B}\n`)).toEqual([A, B]);
  });

  it("reads back the JSON array the column stores", () => {
    expect(parseDiscordIds(JSON.stringify([A, B]))).toEqual([A, B]);
    expect(parseDiscordIds([A, B])).toEqual([A, B]);
  });

  it("de-duplicates", () => {
    expect(parseDiscordIds(`${A}\n${A}\n${B}`)).toEqual([A, B]);
  });

  it("drops a bad entry rather than failing the whole list", () => {
    // One fat-fingered id should not stop everyone else being notified.
    expect(parseDiscordIds(`${A}\nnonsense\n${B}`)).toEqual([A, B]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => `1122334455667788${String(i).padStart(2, "0")}`);
    expect(parseDiscordIds(many.join("\n"))).toHaveLength(25);
    expect(parseDiscordIds(many.join("\n"), { limit: 3 })).toHaveLength(3);
  });

  it("round-trips through the editor's text form", () => {
    expect(formatDiscordIds([A, B])).toBe(`${A}\n${B}`);
    expect(parseDiscordIds(formatDiscordIds([A, B]))).toEqual([A, B]);
    expect(formatDiscordIds(null)).toBe("");
  });
});
