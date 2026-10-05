/**
 * tests/unit/formFieldConfig.test.mjs
 *
 * The per-field `config` blob and the two field types that depend on it.
 *
 * Everything here goes through lib/formFields.js, which imports nothing, so
 * these run without a database, a Discord client or a Fastify app.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_IMAGES_PER_FIELD,
  formatAnswer,
  getAnswerImages,
  getMaxImages,
  getScaleRange,
  isCloudinaryUrl,
  normaliseFieldConfig,
  parseImagesAnswer,
  validateSubmission,
} from "../../lib/formFields.js";

const CLOUD = "zander-cloud";
const url = (name) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/zander/forms/${name}.png`;

const imagesField = (overrides = {}) => ({
  fieldKey: "screenshots",
  label: "Screenshots",
  fieldType: "images",
  isRequired: false,
  position: 0,
  config: null,
  ...overrides,
});

const scaleField = (overrides = {}) => ({
  fieldKey: "experience",
  label: "Experience",
  fieldType: "scale",
  isRequired: false,
  position: 0,
  config: null,
  ...overrides,
});

describe("image count clamping", () => {
  it("defaults to the hard cap when nothing is configured", () => {
    expect(getMaxImages(imagesField())).toBe(MAX_IMAGES_PER_FIELD);
    expect(MAX_IMAGES_PER_FIELD).toBe(10);
  });

  it("clamps a builder asking for more than ten", () => {
    expect(normaliseFieldConfig("images", { maxImages: 250 })).toEqual({ maxImages: 10 });
    expect(getMaxImages(imagesField({ config: { maxImages: 9999 } }))).toBe(10);
  });

  it("clamps zero and negatives up to one", () => {
    expect(getMaxImages(imagesField({ config: { maxImages: 0 } }))).toBe(1);
    expect(getMaxImages(imagesField({ config: { maxImages: -4 } }))).toBe(1);
  });

  it("keeps a sensible value in range", () => {
    expect(getMaxImages(imagesField({ config: { maxImages: 3 } }))).toBe(3);
  });

  it("rejects more images than the field allows, even when the client did not", () => {
    const field = imagesField({ config: { maxImages: 2 } });
    const posted = JSON.stringify([
      { url: url("a") },
      { url: url("b") },
      { url: url("c") },
    ]);

    const result = validateSubmission([field], { screenshots: posted }, { cloudName: CLOUD });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/at most 2 images/);
    // Whatever the error, nothing above the limit is stored.
    expect(result.answers.screenshots).toHaveLength(2);
  });

  it("caps at ten even when the stored config was written before the cap", () => {
    const field = imagesField({ config: { maxImages: 50 } });
    const posted = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({ url: url(`shot${i}`) }))
    );

    const result = validateSubmission([field], { screenshots: posted }, { cloudName: CLOUD });

    expect(result.ok).toBe(false);
    expect(result.answers.screenshots).toHaveLength(10);
  });
});

describe("Cloudinary URL validation", () => {
  it("accepts a URL on the configured cloud", () => {
    expect(isCloudinaryUrl(url("ok"), CLOUD)).toBe(true);
  });

  it("rejects another Cloudinary account", () => {
    expect(isCloudinaryUrl("https://res.cloudinary.com/someone-else/image/upload/v1/x.png", CLOUD)).toBe(false);
  });

  it("rejects an arbitrary host", () => {
    expect(isCloudinaryUrl("https://evil.example.com/x.png", CLOUD)).toBe(false);
    expect(isCloudinaryUrl("https://res.cloudinary.com.evil.example.com/x.png", CLOUD)).toBe(false);
  });

  it("rejects plain http and non-URLs", () => {
    expect(isCloudinaryUrl(`http://res.cloudinary.com/${CLOUD}/image/upload/x.png`, CLOUD)).toBe(false);
    expect(isCloudinaryUrl("not a url", CLOUD)).toBe(false);
    expect(isCloudinaryUrl("", CLOUD)).toBe(false);
    expect(isCloudinaryUrl(null, CLOUD)).toBe(false);
  });

  it("still checks the host when no cloud name is configured", () => {
    expect(isCloudinaryUrl(url("ok"), null)).toBe(true);
    expect(isCloudinaryUrl("https://evil.example.com/x.png", null)).toBe(false);
  });

  it("drops hand-crafted entries and says so", () => {
    const posted = JSON.stringify([
      { url: url("real") },
      { url: "https://evil.example.com/steal.png" },
    ]);

    const result = validateSubmission([imagesField()], { screenshots: posted }, { cloudName: CLOUD });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/not uploaded through this site/);
    expect(result.answers.screenshots).toEqual([{ url: url("real"), publicId: "" }]);
  });

  it("de-duplicates repeated URLs without calling them rejected", () => {
    const posted = JSON.stringify([{ url: url("same") }, { url: url("same") }]);
    const { images, rejected } = parseImagesAnswer(posted, { cloudName: CLOUD });

    expect(images).toHaveLength(1);
    expect(rejected).toBe(0);
  });

  it("keeps the dimensions the upload endpoint returned", () => {
    const posted = [{ url: url("a"), publicId: "zander/forms/a", width: 1920, height: 1080 }];
    const { images } = parseImagesAnswer(posted, { cloudName: CLOUD });

    expect(images[0]).toEqual({
      url: url("a"),
      publicId: "zander/forms/a",
      width: 1920,
      height: 1080,
    });
  });

  it("treats a required but empty image field as missing", () => {
    const result = validateSubmission(
      [imagesField({ isRequired: true })],
      { screenshots: "[]" },
      { cloudName: CLOUD }
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/is required/);
  });
});

describe("scale range", () => {
  it("defaults to 1-10", () => {
    expect(getScaleRange(scaleField())).toEqual({ min: 1, max: 10, minLabel: "", maxLabel: "" });
  });

  it("clamps scaleMin into [0,1] and scaleMax into [2,10]", () => {
    expect(normaliseFieldConfig("scale", { scaleMin: -5, scaleMax: 99 }))
      .toMatchObject({ scaleMin: 0, scaleMax: 10 });
    expect(normaliseFieldConfig("scale", { scaleMin: 7, scaleMax: 1 }))
      .toMatchObject({ scaleMin: 1, scaleMax: 2 });
  });

  it("keeps end labels but drops blanks", () => {
    expect(normaliseFieldConfig("scale", { scaleMin: 1, scaleMax: 5, scaleMinLabel: "Poor", scaleMaxLabel: "  " }))
      .toEqual({ scaleMin: 1, scaleMax: 5, scaleMinLabel: "Poor" });
  });

  it("accepts a value inside the range", () => {
    const field = scaleField({ config: { scaleMin: 1, scaleMax: 5 } });
    const result = validateSubmission([field], { experience: "4" });

    expect(result.ok).toBe(true);
    expect(result.answers.experience).toBe(4);
  });

  it("rejects a value outside the range", () => {
    const field = scaleField({ config: { scaleMin: 1, scaleMax: 5 } });

    for (const bad of ["0", "6", "-1", "99"]) {
      const result = validateSubmission([field], { experience: bad });
      expect(result.ok, `expected ${bad} to be rejected`).toBe(false);
      expect(result.answers.experience).toBeNull();
    }
  });

  it("rejects a non-integer", () => {
    const field = scaleField({ config: { scaleMin: 1, scaleMax: 10 } });

    for (const bad of ["3.5", "three", "1e2"]) {
      expect(validateSubmission([field], { experience: bad }).ok, bad).toBe(false);
    }
  });

  it("is only required when the field says so", () => {
    expect(validateSubmission([scaleField()], {}).ok).toBe(true);
    expect(validateSubmission([scaleField({ isRequired: true })], {}).ok).toBe(false);
  });
});

describe("formatAnswer for the new types", () => {
  it("renders images as numbered markdown links", () => {
    const value = [{ url: url("a") }, { url: url("b") }];

    expect(formatAnswer(imagesField(), value)).toBe(
      `[Image 1](${url("a")}) [Image 2](${url("b")})`
    );
  });

  it("renders an empty image field as blank", () => {
    expect(formatAnswer(imagesField(), [])).toBe("");
    expect(formatAnswer(imagesField(), null)).toBe("");
  });

  it("renders a scale as value over maximum", () => {
    const field = scaleField({ config: { scaleMin: 1, scaleMax: 5 } });
    expect(formatAnswer(field, 4)).toBe("4 / 5");
  });

  it("includes the end labels when they are configured", () => {
    const field = scaleField({
      config: { scaleMin: 1, scaleMax: 10, scaleMinLabel: "Poor", scaleMaxLabel: "Excellent" },
    });
    expect(formatAnswer(field, 7)).toBe("7 / 10 (1 = Poor, 10 = Excellent)");
  });

  it("renders an unanswered scale as blank", () => {
    expect(formatAnswer(scaleField(), null)).toBe("");
    expect(formatAnswer(scaleField(), "")).toBe("");
  });

  it("hands the raw entries to callers that render them", () => {
    const value = [{ url: url("a"), width: 100, height: 50 }];
    expect(getAnswerImages(imagesField(), value)).toEqual(value);
    // Not an images field, so nothing to render.
    expect(getAnswerImages({ fieldType: "text" }, "hello")).toEqual([]);
  });
});

describe("config normalisation in general", () => {
  it("drops keys belonging to another type", () => {
    expect(normaliseFieldConfig("text", { maxImages: 5, scaleMax: 9 })).toBeNull();
    expect(normaliseFieldConfig("images", { scaleMax: 9 })).toEqual({ maxImages: 10 });
  });

  it("survives junk", () => {
    expect(normaliseFieldConfig("text", "not json")).toBeNull();
    expect(normaliseFieldConfig("text", null)).toBeNull();
    expect(normaliseFieldConfig("text", [1, 2, 3])).toBeNull();
  });

  it("reads a config that round-tripped through the column as a JSON string", () => {
    expect(getMaxImages(imagesField({ config: '{"maxImages":4}' }))).toBe(4);
  });
});
