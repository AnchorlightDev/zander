import { describe, it, expect, vi } from "vitest";

// rankOptions is pure, but importing the service pulls in databaseController,
// which opens a mysql2 pool and a PrismaClient at import time.  Stubbed here so
// the unit test neither connects nor leaves a handle open (same reason as
// tests/unit/apiClientAuth.test.mjs).
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  prisma: {},
  luckpermsDb: { query: vi.fn() },
}));

const { rankOptions, AVAILABILITY_WEIGHT } = await import("../../services/meetingPollService.js");

/** Terse helpers so each case reads as the scenario rather than as fixtures. */
const option = (optionId, orderIndex = optionId) => ({ optionId, orderIndex });
const responses = (optionId, { yes = 0, no = 0, maybe = 0 }) => [
  ...Array.from({ length: yes }, () => ({ optionId, availability: "yes" })),
  ...Array.from({ length: no }, () => ({ optionId, availability: "no" })),
  ...Array.from({ length: maybe }, () => ({ optionId, availability: "maybe" })),
];

describe("AVAILABILITY_WEIGHT", () => {
  it("weights a maybe below a yes, and a no at nothing", () => {
    expect(AVAILABILITY_WEIGHT.yes).toBe(1);
    expect(AVAILABILITY_WEIGHT.maybe).toBe(0.5);
    expect(AVAILABILITY_WEIGHT.no).toBe(0);
  });
});

describe("rankOptions", () => {
  it("returns every option even when nothing has been answered", () => {
    const ranked = rankOptions([option(1), option(2)], []);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((o) => o.score === 0)).toBe(true);
    expect(ranked.every((o) => o.responseCount === 0)).toBe(true);
  });

  it("tallies yes, no and maybe counts per option", () => {
    const [ranked] = rankOptions([option(1)], responses(1, { yes: 2, no: 1, maybe: 3 }));

    expect(ranked.yesCount).toBe(2);
    expect(ranked.noCount).toBe(1);
    expect(ranked.maybeCount).toBe(3);
    expect(ranked.responseCount).toBe(6);
  });

  it("scores by weighted availability, not raw response count", () => {
    // Option 2 has more responses but they are mostly 'no'; option 1 has fewer
    // responses that are all 'yes'.  Counting responses would invert this.
    const options = [option(1), option(2)];
    const answers = [
      ...responses(1, { yes: 3 }),
      ...responses(2, { yes: 1, no: 5 }),
    ];

    const ranked = rankOptions(options, answers);

    expect(ranked[0].optionId).toBe(1);
    expect(ranked[0].responseCount).toBeLessThan(ranked[1].responseCount);
  });

  it("weights a maybe at half a yes", () => {
    const ranked = rankOptions([option(1), option(2)], [
      ...responses(1, { yes: 1 }),
      ...responses(2, { maybe: 1 }),
    ]);

    expect(ranked[0].optionId).toBe(1);
    expect(ranked[0].score).toBe(1);
    expect(ranked[1].score).toBe(0.5);
  });

  it("ranks two maybes level with one yes on score", () => {
    const ranked = rankOptions([option(1), option(2)], [
      ...responses(1, { yes: 1 }),
      ...responses(2, { maybe: 2 }),
    ]);

    expect(ranked[0].score).toBe(ranked[1].score);
  });

  it("breaks a score tie in favour of the option with more firm yeses", () => {
    const ranked = rankOptions([option(1), option(2)], [
      ...responses(1, { maybe: 2 }),
      ...responses(2, { yes: 1 }),
    ]);

    expect(ranked[0].optionId).toBe(2);
    expect(ranked[0].yesCount).toBe(1);
  });

  it("breaks a score and yes tie in favour of the option with fewer nos", () => {
    const ranked = rankOptions([option(1), option(2)], [
      ...responses(1, { yes: 2, no: 4 }),
      ...responses(2, { yes: 2, no: 0 }),
    ]);

    expect(ranked[0].optionId).toBe(2);
  });

  it("falls back to the organiser's ordering when everything else ties", () => {
    const ranked = rankOptions(
      [
        { optionId: 9, orderIndex: 1 },
        { optionId: 4, orderIndex: 0 },
      ],
      []
    );

    expect(ranked.map((o) => o.optionId)).toEqual([4, 9]);
  });

  it("does not let a no drag an option below an unanswered one", () => {
    // A 'no' is weighted 0, not negative: a slot everyone declined scores the
    // same as one nobody has looked at, rather than sorting beneath it.
    const ranked = rankOptions([option(1), option(2)], responses(1, { no: 5 }));

    expect(ranked[0].score).toBe(0);
    expect(ranked[1].score).toBe(0);
  });

  it("ignores responses pointing at an option that is no longer on the poll", () => {
    const ranked = rankOptions([option(1)], [
      ...responses(1, { yes: 1 }),
      ...responses(99, { yes: 50 }),
    ]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0].optionId).toBe(1);
    expect(ranked[0].score).toBe(1);
  });

  it("ignores an unrecognised availability value rather than scoring it", () => {
    const ranked = rankOptions([option(1)], [
      { optionId: 1, availability: "yes" },
      { optionId: 1, availability: "probably" },
    ]);

    expect(ranked[0].responseCount).toBe(1);
    expect(ranked[0].score).toBe(1);
  });

  it("does not mutate the options it was given", () => {
    const options = [option(1), option(2)];
    const snapshot = JSON.parse(JSON.stringify(options));

    rankOptions(options, responses(1, { yes: 3 }));

    expect(options).toEqual(snapshot);
  });

  it("counts only the responses it is handed, so a caller can exclude removed invitees", () => {
    // getPollById filters soft-removed invitees' answers out before calling
    // this — a removed person's availability must not keep deciding the time.
    const options = [option(1), option(2)];
    const all = [
      ...responses(1, { yes: 1 }), // from a since-removed invitee
      ...responses(2, { yes: 1 }),
      ...responses(2, { maybe: 1 }),
    ];

    const withRemoved = rankOptions(options, all);
    const activeOnly = rankOptions(options, all.slice(1));

    expect(withRemoved.find((o) => o.optionId === 1).score).toBe(1);
    expect(activeOnly.find((o) => o.optionId === 1).score).toBe(0);
    expect(activeOnly[0].optionId).toBe(2);
  });

  it("is deterministic across repeated calls on the same input", () => {
    const options = [option(1), option(2), option(3)];
    const answers = [
      ...responses(1, { yes: 1, maybe: 1 }),
      ...responses(2, { yes: 1, maybe: 1 }),
      ...responses(3, { maybe: 3 }),
    ];

    const first = rankOptions(options, answers).map((o) => o.optionId);
    const second = rankOptions(options, answers).map((o) => o.optionId);

    expect(first).toEqual(second);
  });
});
