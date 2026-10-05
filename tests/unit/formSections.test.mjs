/**
 * tests/unit/formSections.test.mjs
 *
 * Section breaks: how a flat field list splits into wizard pages, and what a
 * section does to validation.
 */

import { describe, expect, it } from "vitest";
import {
  collectDraftAnswers,
  groupIntoSections,
  isDisplayType,
  isSinglePage,
  validateSubmission,
} from "../../lib/formFields.js";

let position = 0;
const field = (fieldKey, fieldType, over = {}) => ({
  fieldKey,
  label: fieldKey,
  fieldType,
  isRequired: false,
  options: null,
  config: null,
  position: position++,
  ...over,
});

const reset = () => { position = 0; };

const section = (fieldKey, over = {}) => field(fieldKey, "section", over);

const roleField = (over = {}) =>
  field("applying_for", "select", {
    options: [
      { label: "Moderator", value: "moderator" },
      { label: "Builder", value: "builder" },
    ],
    ...over,
  });

const showIf = (fieldKey, equals) => ({ showIf: { fieldKey, equals } });

describe("isDisplayType", () => {
  it("knows a section collects nothing", () => {
    expect(isDisplayType("section")).toBe(true);
    expect(isDisplayType("text")).toBe(false);
    expect(isDisplayType("images")).toBe(false);
    expect(isDisplayType("nonsense")).toBe(false);
  });
});

describe("groupIntoSections", () => {
  it("puts a form with no markers on one untitled page", () => {
    reset();
    const sections = groupIntoSections([field("a", "text"), field("b", "textarea")]);

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("");
    expect(sections[0].fields.map((f) => f.fieldKey)).toEqual(["a", "b"]);
    expect(isSinglePage([field("a", "text")])).toBe(true);
  });

  it("starts a new page at each marker", () => {
    reset();
    const sections = groupIntoSections([
      section("about", { label: "About you", helpText: "Tell us a bit." }),
      field("name", "text"),
      section("experience", { label: "Experience" }),
      field("why", "textarea"),
      field("built", "textarea"),
    ]);

    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("About you");
    expect(sections[0].description).toBe("Tell us a bit.");
    expect(sections[0].fields.map((f) => f.fieldKey)).toEqual(["name"]);
    expect(sections[1].title).toBe("Experience");
    expect(sections[1].fields.map((f) => f.fieldKey)).toEqual(["why", "built"]);
  });

  it("gives fields before the first marker an untitled page of their own", () => {
    reset();
    const sections = groupIntoSections([
      field("name", "text"),
      section("more", { label: "More" }),
      field("why", "textarea"),
    ]);

    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("");
    expect(sections[0].fields.map((f) => f.fieldKey)).toEqual(["name"]);
    expect(sections[1].title).toBe("More");
  });

  it("orders by position, not array order", () => {
    const sections = groupIntoSections([
      { fieldKey: "why", fieldType: "textarea", position: 3 },
      { fieldKey: "one", fieldType: "section", label: "One", position: 0 },
      { fieldKey: "name", fieldType: "text", position: 1 },
      { fieldKey: "two", fieldType: "section", label: "Two", position: 2 },
    ]);

    expect(sections.map((s) => s.title)).toEqual(["One", "Two"]);
    expect(sections[0].fields.map((f) => f.fieldKey)).toEqual(["name"]);
    expect(sections[1].fields.map((f) => f.fieldKey)).toEqual(["why"]);
  });

  it("keeps a marker's own condition, so a whole page can be skipped", () => {
    reset();
    const sections = groupIntoSections([
      roleField(),
      section("mod_page", { label: "Moderator questions", config: showIf("applying_for", ["moderator"]) }),
      field("mod_experience", "textarea"),
    ]);

    expect(sections[1].showIf).toEqual({ fieldKey: "applying_for", equals: ["moderator"] });
  });

  it("allows an empty page, for a heading with nothing under it yet", () => {
    reset();
    const sections = groupIntoSections([section("empty", { label: "Coming soon" })]);

    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toEqual([]);
  });

  it("is not single-page once a titled section exists", () => {
    reset();
    expect(isSinglePage([section("a", { label: "One" }), field("x", "text")])).toBe(false);
  });

  it("handles a form with no fields at all", () => {
    expect(groupIntoSections([])).toEqual([]);
    expect(groupIntoSections()).toEqual([]);
  });
});

describe("validateSubmission with sections", () => {
  it("never stores or requires a section marker", () => {
    reset();
    const fields = [
      section("about", { label: "About you", isRequired: true }),
      field("name", "text", { isRequired: true }),
    ];

    const result = validateSubmission(fields, { name: "Ben", about: "smuggled" });

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ name: "Ben" });
    expect(result.answers).not.toHaveProperty("about");
  });

  it("collapses every field on a page whose section condition failed", () => {
    reset();
    const fields = [
      roleField(),
      section("mod_page", { label: "Moderator", config: showIf("applying_for", ["moderator"]) }),
      field("mod_experience", "textarea", { isRequired: true }),
      field("mod_hours", "number", { isRequired: true }),
    ];

    const result = validateSubmission(fields, {
      applying_for: "builder",
      mod_experience: "should not be stored",
      mod_hours: "40",
    });

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ applying_for: "builder" });
  });

  it("enforces that page normally when the section condition is met", () => {
    reset();
    const fields = [
      roleField(),
      section("mod_page", { label: "Moderator", config: showIf("applying_for", ["moderator"]) }),
      field("mod_experience", "textarea", { isRequired: true }),
    ];

    const result = validateSubmission(fields, { applying_for: "moderator" });

    expect(result.ok).toBe(false);
    expect(result.errorKeys).toContain("mod_experience");
  });

  it("stops collapsing at the next section marker", () => {
    reset();
    const fields = [
      roleField(),
      section("mod_page", { label: "Moderator", config: showIf("applying_for", ["moderator"]) }),
      field("mod_experience", "textarea"),
      section("everyone", { label: "Everyone" }),
      field("agree", "boolean", { isRequired: true }),
    ];

    const result = validateSubmission(fields, { applying_for: "builder", agree: "on" });

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ applying_for: "builder", agree: true });
  });
});

describe("errorKeys", () => {
  it("names the field behind each failure", () => {
    reset();
    const result = validateSubmission(
      [field("name", "text", { isRequired: true }), field("age", "number")],
      { age: "not a number" }
    );

    expect(result.ok).toBe(false);
    expect(result.errorKeys).toEqual(["name", "age"]);
  });

  it("lists a field once even if it fails twice", () => {
    reset();
    const images = field("shots", "images", { isRequired: true, config: { maxImages: 1 } });
    const result = validateSubmission([images], { shots: '["https://evil.example.com/x.png"]' }, {
      cloudName: "zander-cloud",
    });

    expect(result.ok).toBe(false);
    expect(result.errorKeys).toEqual(["shots"]);
  });

  it("is empty on success", () => {
    reset();
    expect(validateSubmission([field("name", "text")], { name: "Ben" }).errorKeys).toEqual([]);
  });
});

describe("drafts ignore section markers", () => {
  it("stores nothing for them", () => {
    reset();
    const fields = [section("about", { label: "About you" }), field("name", "text")];

    expect(collectDraftAnswers(fields, { about: "x", name: "half typed" })).toEqual({
      name: "half typed",
    });
  });
});
