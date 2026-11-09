import { describe, expect, it } from "vitest";
import {
  NICKNAME_COLOR_KEYS,
  DEFAULT_RANK_WORDS,
  buildSkeleton,
  editDistance,
  withinEditDistance,
  matchesAnyWord,
  normalise,
  validateFormat,
  validateColor,
  validateNicknameContent,
  messageForCode,
} from "../../lib/nicknames/nicknameValidation.mjs";

describe("buildSkeleton - lookalike folding", () => {
  it("lowercases", () => {
    expect(buildSkeleton("HeLLo")).toBe("hello");
  });

  it("folds every single-character lookalike", () => {
    expect(buildSkeleton("0")).toBe("o"); // zero -> o
    expect(buildSkeleton("1")).toBe("l"); // one -> l
    expect(buildSkeleton("i")).toBe("l"); // i -> l
    expect(buildSkeleton("3")).toBe("e");
    expect(buildSkeleton("4")).toBe("a");
    expect(buildSkeleton("5")).toBe("s");
    expect(buildSkeleton("7")).toBe("t");
    expect(buildSkeleton("8")).toBe("b");
  });

  it("collapses i, l and 1 to the same letter", () => {
    expect(buildSkeleton("lil")).toBe("lll");
    expect(buildSkeleton("1i1")).toBe("lll");
  });

  it("folds rn -> m", () => {
    expect(buildSkeleton("rn")).toBe("m");
    expect(buildSkeleton("Barney")).toBe("bamey");
  });

  it("folds vv -> w", () => {
    expect(buildSkeleton("vv")).toBe("w");
    expect(buildSkeleton("Wavvy")).toBe("wawy");
  });

  it("strips underscores and other non-alphanumerics", () => {
    expect(buildSkeleton("a_b_c")).toBe("abc");
    expect(buildSkeleton("__x__")).toBe("x");
  });

  it("maps leetspoof and clean form to the same skeleton", () => {
    expect(buildSkeleton("sh1t")).toBe(buildSkeleton("shit"));
    expect(buildSkeleton("N0t0ri0us")).toBe(buildSkeleton("Notorious"));
    expect(buildSkeleton("Steve")).toBe(buildSkeleton("5t3v3"));
  });

  it("treats capitalisation variants of a name as identical (own-username rule)", () => {
    expect(buildSkeleton("NotchKing")).toBe(buildSkeleton("notchking"));
    expect(buildSkeleton("nOtChKiNg")).toBe(buildSkeleton("NOTCHKING"));
  });

  it("handles null/undefined", () => {
    expect(buildSkeleton(null)).toBe("");
    expect(buildSkeleton(undefined)).toBe("");
  });
});

describe("editDistance / withinEditDistance", () => {
  it("is zero for equal strings", () => {
    expect(editDistance("steve", "steve")).toBe(0);
  });

  it("counts single edits", () => {
    expect(editDistance("steve", "steev")).toBe(2); // transposition = 2 in Levenshtein
    expect(editDistance("steve", "stevo")).toBe(1); // substitution
    expect(editDistance("steve", "steves")).toBe(1); // insertion
    expect(editDistance("steve", "stev")).toBe(1); // deletion
  });

  it("withinEditDistance detects distance-1 staff matches", () => {
    expect(withinEditDistance("adminx", "adminy", 1)).toBe(true); // 1 substitution
    expect(withinEditDistance("notch", "notche", 1)).toBe(true); // 1 insertion
    expect(withinEditDistance("notch", "notc", 1)).toBe(true); // 1 deletion
    expect(withinEditDistance("notch", "notch", 1)).toBe(true); // identical
  });

  it("withinEditDistance rejects distance > 1", () => {
    expect(withinEditDistance("notch", "blork", 1)).toBe(false);
    expect(withinEditDistance("steve", "steav", 1)).toBe(false); // 2 edits
  });

  it("short-circuits on length difference", () => {
    expect(withinEditDistance("a", "abc", 1)).toBe(false);
  });
});

describe("normalise", () => {
  it("lowercases and strips non-alphanumerics without folding", () => {
    expect(normalise("Hello_World!")).toBe("helloworld");
    expect(normalise("ADMIN")).toBe("admin");
  });
});

describe("matchesAnyWord", () => {
  it("matches a banned word as a substring", () => {
    expect(matchesAnyWord("superadmin99", ["admin"])).toBe(true);
    expect(matchesAnyWord("friendly", ["admin"])).toBe(false);
  });

  it("catches leetspeak via folding", () => {
    expect(matchesAnyWord("xXsh1tXx", ["shit"])).toBe(true);
    expect(matchesAnyWord("5taff", ["staff"])).toBe(true);
  });

  it("sees through underscores", () => {
    expect(matchesAnyWord("a_d_m_i_n", ["admin"])).toBe(true);
  });

  it("matches rank words from the default list", () => {
    expect(matchesAnyWord("TheOwner", DEFAULT_RANK_WORDS)).toBe(true);
    expect(matchesAnyWord("M0derat0r", DEFAULT_RANK_WORDS)).toBe(true);
  });

  it("returns false for empty/invalid word lists", () => {
    expect(matchesAnyWord("anything", [])).toBe(false);
    expect(matchesAnyWord("anything", null)).toBe(false);
    expect(matchesAnyWord("anything", ["", "  "])).toBe(false);
  });
});

describe("validateFormat - length and character edges", () => {
  it("rejects non-strings and empty", () => {
    expect(validateFormat(123).code).toBe("not_string");
    expect(validateFormat("").code).toBe("empty");
    expect(validateFormat("   ").code).toBe("empty");
  });

  it("enforces min length 3", () => {
    expect(validateFormat("ab").code).toBe("too_short");
    expect(validateFormat("abc").ok).toBe(true);
  });

  it("enforces max length 16", () => {
    expect(validateFormat("a".repeat(16)).ok).toBe(true);
    expect(validateFormat("a".repeat(17)).code).toBe("too_long");
  });

  it("allows only letters, numbers and underscore", () => {
    expect(validateFormat("Good_Name1").ok).toBe(true);
    expect(validateFormat("bad name").code).toBe("invalid_characters"); // space
    expect(validateFormat("bad-name").code).toBe("invalid_characters"); // hyphen
  });

  it("blocks formatting codes and markup by construction", () => {
    expect(validateFormat("&cRed").code).toBe("invalid_characters");
    expect(validateFormat("§cRed").code).toBe("invalid_characters"); // section sign
    expect(validateFormat("<red>hi").code).toBe("invalid_characters");
  });

  it("blocks non-ASCII lookalike scripts and zero-width characters", () => {
    expect(validateFormat("Админ").code).toBe("invalid_characters"); // Cyrillic
    expect(validateFormat("Steve​").code).toBe("invalid_characters"); // zero-width space
  });

  it("trims surrounding whitespace before validating", () => {
    const r = validateFormat("  Steve  ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("Steve");
  });
});

describe("validateColor", () => {
  it("accepts palette keys (case-insensitive)", () => {
    for (const key of NICKNAME_COLOR_KEYS) {
      expect(validateColor(key).ok).toBe(true);
    }
    expect(validateColor("RED").value).toBe("red");
  });

  it("treats empty/null as plain unless required", () => {
    expect(validateColor(null)).toEqual({ ok: true, value: null });
    expect(validateColor("")).toEqual({ ok: true, value: null });
    expect(validateColor(null, { required: true }).code).toBe("invalid_color");
  });

  it("rejects unknown colours and raw codes", () => {
    expect(validateColor("chartreuse").code).toBe("invalid_color");
    expect(validateColor("#ff0000").code).toBe("invalid_color");
    expect(validateColor("&c").code).toBe("invalid_color");
  });
});

describe("validateNicknameContent - integrated", () => {
  const bannedWords = ["shit", "noob"];

  it("accepts a clean nickname and returns skeleton + colour", () => {
    const r = validateNicknameContent({ name: "JingleBelle", color: "gold", bannedWords });
    expect(r.ok).toBe(true);
    expect(r.value).toBe("JingleBelle");
    expect(r.color).toBe("gold");
    expect(r.skeleton).toBe(buildSkeleton("JingleBelle"));
    expect(r.normalised).toBe("jinglebelle");
  });

  it("accepts a plain nickname with no colour", () => {
    const r = validateNicknameContent({ name: "PlainJane", bannedWords });
    expect(r.ok).toBe(true);
    expect(r.color).toBe(null);
  });

  it("rejects on format first", () => {
    expect(validateNicknameContent({ name: "x", bannedWords }).code).toBe("too_short");
  });

  it("rejects rank words", () => {
    const r = validateNicknameContent({ name: "AdminGuy", bannedWords });
    expect(r.code).toBe("rank_word");
    expect(r.message).toBe(messageForCode("rank_word"));
  });

  it("rejects banned words (including leetspeak)", () => {
    expect(validateNicknameContent({ name: "lilsh1t", bannedWords }).code).toBe("blocked_word");
    expect(validateNicknameContent({ name: "xXnoobXx", bannedWords }).code).toBe("blocked_word");
  });

  it("rejects invalid colours", () => {
    expect(validateNicknameContent({ name: "CleanName", color: "neon", bannedWords }).code).toBe(
      "invalid_color"
    );
  });

  it("does not leak the matched word or list in the message", () => {
    const r = validateNicknameContent({ name: "lilsh1t", bannedWords });
    expect(r.message).not.toMatch(/shit/i);
  });
});
