/**
 * tests/unit/formRequirementsGlobals.test.mjs
 *
 * Site-wide eligibility defaults, and how one form's own settings combine with
 * them. Pure — no database, no settings table.
 */

import { describe, expect, it } from "vitest";
import {
  DISABLE_CHECK,
  effectiveRequirements,
  mergeRequirements,
  summariseRequirements,
} from "../../lib/formRequirements.mjs";

const GLOBALS = { minPlaytimeHours: 20, noPunishmentsDays: 90 };

describe("mergeRequirements", () => {
  it("uses the defaults when the form sets nothing", () => {
    expect(mergeRequirements(GLOBALS, null)).toEqual(GLOBALS);
    expect(mergeRequirements(GLOBALS, {})).toEqual(GLOBALS);
  });

  it("uses the form's own when there are no defaults", () => {
    expect(mergeRequirements(null, { minPlaytimeHours: 5 })).toEqual({ minPlaytimeHours: 5 });
  });

  it("is null when neither side has anything", () => {
    expect(mergeRequirements(null, null)).toBeNull();
    expect(mergeRequirements({}, {})).toBeNull();
  });

  it("lets the form override a single default and inherit the rest", () => {
    expect(mergeRequirements(GLOBALS, { minPlaytimeHours: 40 })).toEqual({
      minPlaytimeHours: 40,
      noPunishmentsDays: 90,
    });
  });

  it("lets the form add a check the defaults do not have", () => {
    expect(mergeRequirements(GLOBALS, { minMinecraftActiveDays: 12 })).toEqual({
      minPlaytimeHours: 20,
      noPunishmentsDays: 90,
      minMinecraftActiveDays: 12,
      minMinecraftActiveWindowDays: 30,
    });
  });

  it("switches an inherited check off when the form sets it to zero", () => {
    // Absent means inherit, so there has to be a value that means "not this
    // one". Zero is it, and it can never survive as a real threshold.
    expect(mergeRequirements(GLOBALS, { noPunishmentsDays: DISABLE_CHECK })).toEqual({
      minPlaytimeHours: 20,
    });
    expect(DISABLE_CHECK).toBe(0);
  });

  it("can switch every inherited check off", () => {
    expect(mergeRequirements(GLOBALS, { minPlaytimeHours: 0, noPunishmentsDays: 0 })).toBeNull();
  });

  it("still clamps after merging", () => {
    expect(mergeRequirements({ noPunishmentsDays: 99999 }, null)).toEqual({
      noPunishmentsDays: 3650,
    });
  });

  it("reads either side back out of the JSON column", () => {
    expect(mergeRequirements(JSON.stringify(GLOBALS), '{"minPlaytimeHours":40}')).toEqual({
      minPlaytimeHours: 40,
      noPunishmentsDays: 90,
    });
  });

  it("ignores junk on either side", () => {
    expect(mergeRequirements("not json", { minPlaytimeHours: 5 })).toEqual({ minPlaytimeHours: 5 });
    expect(mergeRequirements(GLOBALS, "not json")).toEqual(GLOBALS);
  });
});

describe("effectiveRequirements", () => {
  it("ignores the defaults entirely when the form has not opted in", () => {
    // The whole point of the opt-in: setting a site-wide playtime threshold
    // must not start turning people away from a feedback survey.
    const survey = { useGlobalRequirements: false, requirements: null };
    expect(effectiveRequirements(survey, GLOBALS)).toBeNull();
  });

  it("keeps a non-opted-in form's own rules exactly as they are", () => {
    const form = { useGlobalRequirements: false, requirements: { minPlaytimeHours: 5 } };
    expect(effectiveRequirements(form, GLOBALS)).toEqual({ minPlaytimeHours: 5 });
  });

  it("inherits when the form has opted in", () => {
    const application = { useGlobalRequirements: true, requirements: null };
    expect(effectiveRequirements(application, GLOBALS)).toEqual(GLOBALS);
  });

  it("merges the form's overrides over the defaults when opted in", () => {
    const application = { useGlobalRequirements: true, requirements: { minPlaytimeHours: 40 } };
    expect(effectiveRequirements(application, GLOBALS)).toEqual({
      minPlaytimeHours: 40,
      noPunishmentsDays: 90,
    });
  });

  it("is null for no form at all", () => {
    expect(effectiveRequirements(null, GLOBALS)).toBeNull();
  });
});

describe("summariseRequirements", () => {
  it("describes each rule without measuring anyone", () => {
    const summary = summariseRequirements(GLOBALS);

    expect(summary).toEqual([
      { key: "minPlaytimeHours", label: "Playtime", required: "20 hours played" },
      {
        key: "noPunishmentsDays",
        label: "Punishment history",
        required: "no punishments in the last 90 days",
      },
    ]);
  });

  it("is empty when nothing is set", () => {
    expect(summariseRequirements(null)).toEqual([]);
    expect(summariseRequirements({})).toEqual([]);
  });

  it("describes the Discord checks too, rather than skipping them", () => {
    // Nothing is measured here, so the cold-start skip must not swallow them —
    // the editor has to show an admin what a form would inherit.
    const summary = summariseRequirements({ minDiscordActiveDays: 8, minDiscordMessages: 50 });
    expect(summary.map((c) => c.key)).toEqual(["minDiscordActiveDays", "minDiscordMessages"]);
  });
});
