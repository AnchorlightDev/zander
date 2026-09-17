import { describe, it, expect, vi } from "vitest";

// fitReportReason is pure, but the route module pulls in api/common.js, which
// imports databaseController and opens mysql2 pools at import time (same
// reason as tests/unit/apiClientAuth.test.mjs).
vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: vi.fn() },
  prisma: {},
  luckpermsDb: { query: vi.fn() },
  punishmentsDb: { query: vi.fn() },
}));

vi.mock("../../controllers/announcementController.js", () => ({
  getWebAnnouncement: vi.fn(async () => null),
}));

const { fitReportReason, REPORT_REASON_MAX_LENGTH } = await import(
  "../../api/routes/report.js"
);

/**
 * Production threw "Data too long for column 'reportReason'", losing the whole
 * report. The column is VARCHAR(100); the web form and the /report slash
 * command both submitted unbounded text straight into it.
 */
describe("fitReportReason", () => {
  it("matches the column width declared in the schema", () => {
    expect(REPORT_REASON_MAX_LENGTH).toBe(100);
  });

  it("leaves a short reason untouched", () => {
    const result = fitReportReason("Griefing my base", null);
    expect(result.reportReason).toBe("Griefing my base");
    expect(result.reportReasonEvidence).toBeNull();
  });

  it("leaves a reason of exactly the limit untouched", () => {
    const exact = "B".repeat(100);
    const result = fitReportReason(exact, null);
    expect(result.reportReason).toBe(exact);
    expect(result.reportReasonEvidence).toBeNull();
  });

  it("truncates one character over the limit", () => {
    const result = fitReportReason("C".repeat(101), null);
    expect(result.reportReason).toHaveLength(100);
  });

  it("never returns a reason the column would reject", () => {
    for (const length of [0, 1, 99, 100, 101, 250, 4000]) {
      const result = fitReportReason("A".repeat(length), null);
      expect(result.reportReason.length).toBeLessThanOrEqual(REPORT_REASON_MAX_LENGTH);
    }
  });

  it("preserves the full reason in the evidence field when truncating", () => {
    const long = "A".repeat(250);
    const result = fitReportReason(long, null);

    // Nothing the reporter wrote may be lost — evidence is MEDIUMTEXT.
    expect(result.reportReasonEvidence).toContain(long);
  });

  it("keeps existing evidence alongside the preserved reason", () => {
    const long = "A".repeat(250);
    const result = fitReportReason(long, "screenshot.png");

    expect(result.reportReasonEvidence).toContain(long);
    expect(result.reportReasonEvidence).toContain("screenshot.png");
  });

  it("does not touch evidence when the reason already fits", () => {
    const result = fitReportReason("Short", "screenshot.png");
    expect(result.reportReasonEvidence).toBe("screenshot.png");
  });

  it("passes a non-string through untouched", () => {
    // required() returns the response object rather than a string when the
    // field is missing; that must not be mangled into a truncated string.
    const sentinel = { notAString: true };
    expect(fitReportReason(sentinel, null).reportReason).toBe(sentinel);
  });

  it("defaults evidence to null when omitted", () => {
    expect(fitReportReason("Short").reportReasonEvidence).toBeNull();
  });
});
