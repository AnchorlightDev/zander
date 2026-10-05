import { describe, it, expect } from "vitest";
import {
  FIELD_TYPES,
  formatAnswer,
  getFieldType,
  isAutoFillType,
  isValidFieldType,
  isValidSubmissionStatus,
  normaliseOptions,
  optionsToText,
  slugifyKey,
  uniqueKey,
  validateSubmission,
} from "../../lib/formFields.js";

describe("field type catalogue", () => {
  it("recognises every declared type and rejects unknown ones", () => {
    for (const type of FIELD_TYPES) {
      expect(isValidFieldType(type.value)).toBe(true);
    }
    expect(isValidFieldType("sql_injection")).toBe(false);
    expect(isValidFieldType("")).toBe(false);
    expect(isValidFieldType(undefined)).toBe(false);
    expect(getFieldType("nope")).toBeNull();
  });

  it("marks the session-derived types as auto-filled", () => {
    expect(isAutoFillType("mc_uuid")).toBe(true);
    expect(isAutoFillType("discord_tag")).toBe(true);
    expect(isAutoFillType("text")).toBe(false);
  });
});

describe("slugifyKey / uniqueKey", () => {
  it("turns a label into a safe key", () => {
    expect(slugifyKey("Why do you want to join?")).toBe("why_do_you_want_to_join");
    expect(slugifyKey("  Age (years)  ")).toBe("age_years");
    expect(slugifyKey("It's your call")).toBe("its_your_call");
  });

  it("falls back rather than producing an empty key", () => {
    expect(slugifyKey("???")).toBe("field");
    expect(slugifyKey("")).toBe("field");
  });

  it("de-duplicates against keys already in the form", () => {
    expect(uniqueKey("Name", [])).toBe("name");
    expect(uniqueKey("Name", ["name"])).toBe("name_2");
    expect(uniqueKey("Name", ["name", "name_2"])).toBe("name_3");
  });
});

describe("normaliseOptions", () => {
  it("parses the newline form the editor posts", () => {
    expect(normaliseOptions("Yes\nNo")).toEqual([
      { label: "Yes", value: "Yes" },
      { label: "No", value: "No" },
    ]);
  });

  it("supports Label|value and drops blank lines", () => {
    expect(normaliseOptions("Builder|builder\n\n  Admin|admin  ")).toEqual([
      { label: "Builder", value: "builder" },
      { label: "Admin", value: "admin" },
    ]);
  });

  it("round-trips the JSON stored in the options column", () => {
    const stored = [{ label: "Builder", value: "builder" }];
    expect(normaliseOptions(JSON.stringify(stored))).toEqual(stored);
    expect(normaliseOptions(stored)).toEqual(stored);
  });

  it("drops duplicate values and handles empty input", () => {
    expect(normaliseOptions("A|x\nB|x")).toEqual([{ label: "A", value: "x" }]);
    expect(normaliseOptions("")).toEqual([]);
    expect(normaliseOptions(null)).toEqual([]);
  });

  it("survives a malformed JSON string by falling back to lines", () => {
    expect(normaliseOptions("[not json")).toEqual([{ label: "[not json", value: "[not json" }]);
  });

  it("optionsToText is the inverse of the editor input", () => {
    expect(optionsToText("Yes\nNo|no_thanks")).toBe("Yes\nNo|no_thanks");
  });
});

const field = (over = {}) => ({
  fieldKey: "answer",
  label: "Answer",
  fieldType: "text",
  isRequired: false,
  position: 0,
  options: null,
  maxLength: null,
  ...over,
});

describe("validateSubmission", () => {
  it("accepts a valid answer and keys it by fieldKey", () => {
    const result = validateSubmission([field()], { answer: "  hello  " });
    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ answer: "hello" });
  });

  it("flags missing required fields by label", () => {
    const result = validateSubmission([field({ isRequired: true })], {});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Answer is required."]);
  });

  it("drops keys that are not fields on the form", () => {
    const result = validateSubmission([field()], { answer: "a", injected: "b" });
    expect(result.answers).toEqual({ answer: "a" });
    expect(result.answers.injected).toBeUndefined();
  });

  it("respects the declared field order, not the body order", () => {
    const fields = [
      field({ fieldKey: "second", label: "Second", position: 1, isRequired: true }),
      field({ fieldKey: "first", label: "First", position: 0, isRequired: true }),
    ];
    const result = validateSubmission(fields, {});
    expect(result.errors).toEqual(["First is required.", "Second is required."]);
  });

  describe("auto-filled types", () => {
    it("reads the value from the session, ignoring the body", () => {
      const fields = [field({ fieldKey: "uuid", label: "UUID", fieldType: "mc_uuid" })];
      const result = validateSubmission(fields, { uuid: "someone-elses-uuid" }, {
        user: { uuid: "real-uuid" },
      });
      expect(result.answers.uuid).toBe("real-uuid");
    });

    it("resolves the primary rank from the session rank list", () => {
      const fields = [field({ fieldKey: "rank", label: "Rank", fieldType: "rank" })];
      const result = validateSubmission(fields, {}, {
        user: { ranks: [{ rankSlug: "vip" }, { rankSlug: "member" }] },
      });
      expect(result.answers.rank).toBe("vip");
    });

    it("errors when a required auto-fill value is unavailable", () => {
      const fields = [field({ fieldKey: "dt", label: "Discord", fieldType: "discord_tag", isRequired: true })];
      const result = validateSubmission(fields, {}, { user: {} });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(["Discord could not be read from your account."]);
    });
  });

  describe("option-backed types", () => {
    const choices = field({
      fieldKey: "role",
      label: "Role",
      fieldType: "select",
      options: [{ label: "Builder", value: "builder" }],
    });

    it("accepts a declared choice", () => {
      expect(validateSubmission([choices], { role: "builder" }).answers.role).toBe("builder");
    });

    it("rejects a value that is not on the list", () => {
      const result = validateSubmission([choices], { role: "admin" });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(["Role is not one of the available choices."]);
    });

    it("keeps only declared choices for checkboxes and always stores an array", () => {
      const multi = field({
        fieldKey: "langs",
        label: "Languages",
        fieldType: "checkbox",
        options: [
          { label: "EN", value: "en" },
          { label: "FR", value: "fr" },
        ],
      });
      const result = validateSubmission([multi], { langs: ["en", "zz"] });
      expect(result.answers.langs).toEqual(["en"]);

      // A single checkbox posts a scalar, not an array.
      expect(validateSubmission([multi], { langs: "fr" }).answers.langs).toEqual(["fr"]);
      expect(validateSubmission([multi], {}).answers.langs).toEqual([]);
    });

    it("requires at least one checkbox when the field is required", () => {
      const multi = field({
        fieldKey: "langs",
        label: "Languages",
        fieldType: "checkbox",
        isRequired: true,
        options: [{ label: "EN", value: "en" }],
      });
      expect(validateSubmission([multi], {}).errors).toEqual(["Languages is required."]);
    });
  });

  describe("scalar type rules", () => {
    it("requires a confirmation tick when the field is required", () => {
      const tick = field({ fieldKey: "agree", label: "Agree", fieldType: "boolean", isRequired: true });
      expect(validateSubmission([tick], { agree: "on" }).answers.agree).toBe(true);
      expect(validateSubmission([tick], {}).errors).toEqual(["Agree must be ticked."]);
      // Unticked but optional is a stored false, not an error.
      const optional = field({ fieldKey: "agree", label: "Agree", fieldType: "boolean" });
      expect(validateSubmission([optional], {}).answers.agree).toBe(false);
    });

    it("rejects a non-numeric number and a non-parsable date", () => {
      const num = field({ fieldKey: "age", label: "Age", fieldType: "number" });
      expect(validateSubmission([num], { age: "twelve" }).errors).toEqual(["Age must be a number."]);
      expect(validateSubmission([num], { age: "12" }).ok).toBe(true);

      const when = field({ fieldKey: "dob", label: "DOB", fieldType: "date" });
      expect(validateSubmission([when], { dob: "not-a-date" }).errors).toEqual(["DOB must be a valid date."]);
      expect(validateSubmission([when], { dob: "2020-01-01" }).ok).toBe(true);
    });

    it("requires an uploaded URL for file fields", () => {
      const upload = field({ fieldKey: "pic", label: "Picture", fieldType: "file" });
      expect(validateSubmission([upload], { pic: "/etc/passwd" }).errors).toEqual([
        "Picture must be an uploaded file.",
      ]);
      expect(validateSubmission([upload], { pic: "https://cdn.example/a.png" }).ok).toBe(true);
    });

    it("enforces maxLength", () => {
      const capped = field({ maxLength: 5 });
      const result = validateSubmission([capped], { answer: "far too long" });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(["Answer must be 5 characters or fewer."]);
    });
  });

  it("skips a field whose stored type is no longer in the catalogue", () => {
    const fields = [field({ fieldType: "legacy_widget", isRequired: true })];
    const result = validateSubmission(fields, {});
    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({});
  });

  it("tolerates a missing field list", () => {
    expect(validateSubmission(null, {}).ok).toBe(true);
  });
});

describe("formatAnswer", () => {
  it("shows option labels rather than stored values", () => {
    const f = field({ fieldType: "select", options: [{ label: "Builder", value: "builder" }] });
    expect(formatAnswer(f, "builder")).toBe("Builder");
  });

  it("joins multi-choice answers", () => {
    const f = field({
      fieldType: "checkbox",
      options: [
        { label: "EN", value: "en" },
        { label: "FR", value: "fr" },
      ],
    });
    expect(formatAnswer(f, ["en", "fr"])).toBe("EN, FR");
    expect(formatAnswer(f, [])).toBe("");
  });

  it("renders booleans and blanks readably", () => {
    expect(formatAnswer(field({ fieldType: "boolean" }), true)).toBe("Yes");
    expect(formatAnswer(field({ fieldType: "boolean" }), false)).toBe("No");
    expect(formatAnswer(field(), "")).toBe("");
    expect(formatAnswer(field(), null)).toBe("");
  });
});

describe("submission statuses", () => {
  it("accepts only the three review states", () => {
    expect(isValidSubmissionStatus("pending")).toBe(true);
    expect(isValidSubmissionStatus("approved")).toBe(true);
    expect(isValidSubmissionStatus("denied")).toBe(true);
    expect(isValidSubmissionStatus("deleted")).toBe(false);
    expect(isValidSubmissionStatus("")).toBe(false);
  });
});
