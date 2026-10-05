import { describe, it, expect, vi } from "vitest";

vi.mock("../../controllers/databaseController.js", () => ({ default: { query: vi.fn() } }));
vi.mock("../../controllers/userController.js", () => ({ UserGetter: class {} }));

const { isNicknameSimilar } = await import("../../lib/discord/nicknameCheck.mjs");

describe("isNicknameSimilar", () => {
  it.each([
    ["imjust_ryanlol", "heyimryanlol927"], // shared run mid-name
    ["heyimryanlol927", "heyimryanlol927"],
    ["Venny", "VenomousViper"],
    ["yecto", "Yecto_FrazeI"],
    ["𝚂𝚔𝚢𝚎𝚖𝚘𝚛𝚛𝚎", "Skyemorre"],
    ["zAv", "zAv7"],
  ])("accepts %s for %s", (display, mc) => {
    expect(isNicknameSimilar(display, mc)).toBe(true);
  });

  it.each([
    ["CoolDude", "heyimryanlol927"],
    ["xryanx", "heyimryanlol927"], // 4-char overlap ("ryan") is below the shared-run threshold
    ["Steve", "Notch"],
  ])("rejects %s for %s", (display, mc) => {
    expect(isNicknameSimilar(display, mc)).toBe(false);
  });
});
