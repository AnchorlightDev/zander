/**
 * tests/unit/formConditions.test.mjs
 *
 * Conditional fields: which conditions survive a save, and what a condition
 * does to validation when it is not met.
 */

import { describe, expect, it } from "vitest";
import {
  collectDraftAnswers,
  isFieldVisible,
  sanitiseShowIfGraph,
  validateSubmission,
} from "../../lib/formFields.js";

const field = (fieldKey, fieldType, over = {}) => ({
  fieldKey,
  label: fieldKey,
  fieldType,
  isRequired: false,
  options: null,
  config: null,
  position: 0,
  ...over,
});

const roleField = (over = {}) =>
  field("applying_for", "select", {
    options: [
      { label: "Moderator", value: "moderator" },
      { label: "Builder", value: "builder" },
    ],
    ...over,
  });

const showIf = (fieldKey, equals) => ({ showIf: { fieldKey, equals } });

describe("isFieldVisible", () => {
  it("shows a field with no condition", () => {
    expect(isFieldVisible(field("why", "textarea"), {})).toBe(true);
  });

  it("shows a field whose condition matches", () => {
    const dependent = field("mod_experience", "textarea", {
      config: showIf("applying_for", ["moderator"]),
    });
    expect(isFieldVisible(dependent, { applying_for: "moderator" })).toBe(true);
  });

  it("hides a field whose condition does not match", () => {
    const dependent = field("mod_experience", "textarea", {
      config: showIf("applying_for", ["moderator"]),
    });
    expect(isFieldVisible(dependent, { applying_for: "builder" })).toBe(false);
    expect(isFieldVisible(dependent, {})).toBe(false);
  });

  it("matches any one of several listed values", () => {
    const dependent = field("x", "text", { config: showIf("applying_for", ["moderator", "admin"]) });
    expect(isFieldVisible(dependent, { applying_for: "admin" })).toBe(true);
    expect(isFieldVisible(dependent, { applying_for: "builder" })).toBe(false);
  });

  it("matches when a checkbox answer contains one of the listed values", () => {
    const dependent = field("x", "text", { config: showIf("interests", ["redstone"]) });
    expect(isFieldVisible(dependent, { interests: ["building", "redstone"] })).toBe(true);
    expect(isFieldVisible(dependent, { interests: ["building"] })).toBe(false);
    expect(isFieldVisible(dependent, { interests: [] })).toBe(false);
  });

  it("reads a confirmation tick as true/false", () => {
    const onTicked = field("x", "text", { config: showIf("agreed", ["true"]) });
    expect(isFieldVisible(onTicked, { agreed: true })).toBe(true);
    expect(isFieldVisible(onTicked, { agreed: false })).toBe(false);

    const onUnticked = field("y", "text", { config: showIf("agreed", ["false"]) });
    expect(isFieldVisible(onUnticked, { agreed: false })).toBe(true);
  });
});

describe("validateSubmission with conditions", () => {
  it("does not require a field whose condition was not met", () => {
    const fields = [
      roleField({ position: 0, isRequired: true }),
      field("mod_experience", "textarea", {
        position: 1,
        isRequired: true,
        config: showIf("applying_for", ["moderator"]),
      }),
    ];

    const result = validateSubmission(fields, { applying_for: "builder" });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.answers).not.toHaveProperty("mod_experience");
  });

  it("still requires it when the condition is met", () => {
    const fields = [
      roleField({ position: 0, isRequired: true }),
      field("mod_experience", "textarea", {
        position: 1,
        isRequired: true,
        config: showIf("applying_for", ["moderator"]),
      }),
    ];

    const result = validateSubmission(fields, { applying_for: "moderator" });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/mod_experience is required/);
  });

  it("discards an answer posted for a field the submitter never saw", () => {
    const fields = [
      roleField({ position: 0 }),
      field("mod_experience", "textarea", {
        position: 1,
        config: showIf("applying_for", ["moderator"]),
      }),
    ];

    const result = validateSubmission(fields, {
      applying_for: "builder",
      mod_experience: "smuggled in by posting directly",
    });

    expect(result.ok).toBe(true);
    expect(result.answers).not.toHaveProperty("mod_experience");
  });

  it("collapses a whole dependent chain when the first condition fails", () => {
    const fields = [
      roleField({ position: 0 }),
      field("mod_level", "select", {
        position: 1,
        options: [{ label: "Senior", value: "senior" }],
        config: showIf("applying_for", ["moderator"]),
      }),
      field("senior_detail", "textarea", {
        position: 2,
        isRequired: true,
        config: showIf("mod_level", ["senior"]),
      }),
    ];

    const result = validateSubmission(fields, {
      applying_for: "builder",
      mod_level: "senior",
      senior_detail: "should not be stored",
    });

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ applying_for: "builder" });
  });
});

describe("sanitiseShowIfGraph", () => {
  const keyed = (rows) => Object.fromEntries(rows.map((r) => [r.fieldKey, r.config]));

  it("keeps a condition pointing at an earlier choice field", () => {
    const rows = sanitiseShowIfGraph([
      roleField({ position: 0 }),
      field("mod_experience", "textarea", { config: showIf("applying_for", ["moderator"]) }),
    ]);

    expect(keyed(rows).mod_experience).toEqual({
      showIf: { fieldKey: "applying_for", equals: ["moderator"] },
    });
  });

  it("drops a condition pointing at a later field", () => {
    const rows = sanitiseShowIfGraph([
      field("mod_experience", "textarea", { config: showIf("applying_for", ["moderator"]) }),
      roleField(),
    ]);

    expect(keyed(rows).mod_experience).toBeNull();
  });

  it("drops a condition pointing at itself", () => {
    const rows = sanitiseShowIfGraph([
      roleField({ config: showIf("applying_for", ["moderator"]) }),
    ]);

    expect(keyed(rows).applying_for).toBeNull();
  });

  it("breaks a two-field cycle, because edges can only point backwards", () => {
    const rows = sanitiseShowIfGraph([
      roleField({ config: showIf("confirm", ["true"]) }),
      field("confirm", "boolean", { config: showIf("applying_for", ["moderator"]) }),
    ]);

    const configs = keyed(rows);
    // The forward edge goes; the backward one is legitimate and stays, so the
    // cycle cannot exist in what is stored.
    expect(configs.applying_for).toBeNull();
    expect(configs.confirm).toEqual({
      showIf: { fieldKey: "applying_for", equals: ["moderator"] },
    });
  });

  it("breaks a three-field cycle the same way", () => {
    const rows = sanitiseShowIfGraph([
      field("a", "select", { options: [{ label: "x", value: "x" }], config: showIf("c", ["x"]) }),
      field("b", "select", { options: [{ label: "x", value: "x" }], config: showIf("a", ["x"]) }),
      field("c", "select", { options: [{ label: "x", value: "x" }], config: showIf("b", ["x"]) }),
    ]);

    const configs = keyed(rows);
    expect(configs.a).toBeNull();
    expect(configs.b).not.toBeNull();
    expect(configs.c).not.toBeNull();
  });

  it("drops a condition on a field type that cannot be a source", () => {
    const rows = sanitiseShowIfGraph([
      field("nickname", "text"),
      field("why", "textarea", { config: showIf("nickname", ["bob"]) }),
    ]);

    expect(keyed(rows).why).toBeNull();
  });

  it("drops a condition pointing at a field that does not exist", () => {
    const rows = sanitiseShowIfGraph([
      field("why", "textarea", { config: showIf("gone_away", ["yes"]) }),
    ]);

    expect(keyed(rows).why).toBeNull();
  });

  it("leaves the rest of a field's config alone when it drops the condition", () => {
    const rows = sanitiseShowIfGraph([
      field("shots", "images", {
        config: { maxImages: 4, showIf: { fieldKey: "nope", equals: ["x"] } },
      }),
    ]);

    expect(keyed(rows).shots).toEqual({ maxImages: 4 });
  });
});

describe("collectDraftAnswers", () => {
  const fields = [
    roleField({ position: 0, isRequired: true }),
    field("why", "textarea", { position: 1, isRequired: true }),
    field("agreed", "boolean", { position: 2, isRequired: true }),
    field("mc_name", "mc_username", { position: 3 }),
  ];

  it("saves a half-finished form without complaining about required fields", () => {
    const result = collectDraftAnswers(fields, { why: "halfway through a sen" });

    expect(result).toEqual({ why: "halfway through a sen" });
  });

  it("keeps only this form's own fields", () => {
    const result = collectDraftAnswers(fields, { why: "x", somethingElse: "dropped" });

    expect(result).toEqual({ why: "x" });
  });

  it("does not store auto-filled fields, which come from the session on submit", () => {
    const result = collectDraftAnswers(fields, { mc_name: "SomeoneElse" });

    expect(result).not.toHaveProperty("mc_name");
  });

  it("keeps only real option values for a choice field", () => {
    const result = collectDraftAnswers(fields, { applying_for: "moderator" });
    expect(result.applying_for).toBe("moderator");
  });

  it("caps a runaway text answer", () => {
    const result = collectDraftAnswers(fields, { why: "a".repeat(50000) });
    expect(result.why).toHaveLength(10000);
  });

  it("ignores conditions entirely - a draft is half-finished by definition", () => {
    const conditional = [
      roleField({ position: 0 }),
      field("mod_experience", "textarea", {
        position: 1,
        isRequired: true,
        config: showIf("applying_for", ["moderator"]),
      }),
    ];

    const result = collectDraftAnswers(conditional, {
      applying_for: "builder",
      mod_experience: "typed before changing my mind",
    });

    expect(result.mod_experience).toBe("typed before changing my mind");
  });
});
