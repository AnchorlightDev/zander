/**
 * tests/unit/formExport.test.mjs
 *
 * CSV writing and the shape of a form export. Pure -- no database.
 */

import { describe, expect, it } from "vitest";
import { csvFilename, escapeCsvCell, toCsv } from "../../lib/csv.mjs";
import { META_COLUMNS, buildSubmissionExport } from "../../lib/formExport.mjs";

describe("escapeCsvCell", () => {
  it("leaves ordinary text alone", () => {
    expect(escapeCsvCell("About right")).toBe("About right");
    expect(escapeCsvCell(7)).toBe("7");
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("quotes anything structural", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(escapeCsvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  describe("formula injection", () => {
    // Answers are typed by the public and opened in Excel by staff, so a cell
    // a spreadsheet would execute has to be neutralised.
    it("neutralises a cell that would be executed", () => {
      expect(escapeCsvCell("=1+1")).toBe("'=1+1");
      expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(escapeCsvCell("=HYPERLINK(\"http://evil\",\"click\")")).toContain("'=HYPERLINK");
    });

    it("still quotes a neutralised cell that also contains a comma", () => {
      expect(escapeCsvCell("=cmd|'/c calc'!A1,x")).toBe("\"'=cmd|'/c calc'!A1,x\"");
    });

    it("leaves plain negative and signed numbers as numbers", () => {
      // "-5" trips the same test as a formula but is obviously data; quoting
      // every negative would make a column of figures useless.
      expect(escapeCsvCell("-5")).toBe("-5");
      expect(escapeCsvCell("+3")).toBe("+3");
      expect(escapeCsvCell("-2.5")).toBe("-2.5");
    });

    it("neutralises something that merely starts like a number", () => {
      expect(escapeCsvCell("-5=1+1")).toBe("'-5=1+1");
    });
  });
});

describe("toCsv", () => {
  it("writes a header and rows with CRLF", () => {
    const csv = toCsv({ columns: ["a", "b"], rows: [[1, 2], [3, 4]] }, { bom: false });
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("prepends a BOM by default, so Excel reads UTF-8", () => {
    expect(toCsv({ columns: ["a"], rows: [["é"]] }).startsWith("﻿")).toBe(true);
    expect(toCsv({ columns: ["a"], rows: [["é"]] }, { bom: false }).startsWith("﻿")).toBe(false);
  });

  it("copes with nothing to write", () => {
    expect(toCsv({}, { bom: false })).toBe("");
    expect(toCsv({ columns: ["a"], rows: [] }, { bom: false })).toBe("a");
  });
});

describe("csvFilename", () => {
  it("joins the parts", () => {
    expect(csvFilename("staff-application", "submissions")).toBe("staff-application-submissions.csv");
  });

  it("cannot break out of a Content-Disposition header", () => {
    expect(csvFilename('Report "2026", v2')).toBe("Report-2026-v2.csv");
    // Dots are fine in a filename; the slashes are the part that mattered.
    expect(csvFilename("../../etc/passwd")).toBe("..-..-etc-passwd.csv");
    expect(csvFilename('a"; rm -rf /')).not.toContain('"');
    expect(csvFilename("")).toBe("export.csv");
  });
});

describe("buildSubmissionExport", () => {
  let position = 0;
  const field = (fieldKey, fieldType, over = {}) => ({
    fieldKey,
    label: fieldKey,
    fieldType,
    options: null,
    config: null,
    position: position++,
    ...over,
  });

  const form = {
    name: "Survey",
    fields: [
      field("about", "section", { label: "About you" }),
      field("hours", "radio", {
        label: "How long did you play?",
        options: [{ label: "1–3 hours", value: "1-3" }],
      }),
      field("fun", "scale", { label: "How fun was it?", config: { scaleMin: 1, scaleMax: 5 } }),
      field("agreed", "boolean", { label: "Confirm" }),
      field("shots", "images", { label: "Screenshots" }),
    ],
  };

  const submissions = [
    {
      submissionId: 1,
      userId: 42,
      createdAt: new Date("2026-09-22T10:00:00.000Z"),
      status: "pending",
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
      answers: {
        hours: "1-3",
        fun: 4,
        agreed: true,
        shots: [{ url: "https://res.cloudinary.com/c/a.png" }, { url: "https://res.cloudinary.com/c/b.png" }],
      },
    },
  ];

  const usernames = new Map([[42, "shadowolfyt"]]);

  it("puts one column per question, in the order the form asks them", () => {
    const { columns } = buildSubmissionExport(form, submissions, { usernames });

    expect(columns.slice(0, META_COLUMNS.length)).toEqual(META_COLUMNS);
    expect(columns.slice(META_COLUMNS.length)).toEqual([
      "How long did you play?",
      "How fun was it?",
      "Confirm",
      "Screenshots",
    ]);
  });

  it("skips section breaks, which have no answer", () => {
    const { columns } = buildSubmissionExport(form, submissions, { usernames });
    expect(columns).not.toContain("About you");
  });

  it("writes answers the way the dashboard shows them", () => {
    const [row] = buildSubmissionExport(form, submissions, { usernames }).rows;
    const answers = row.slice(META_COLUMNS.length);

    // The option label, not the stored value; Yes rather than true.
    expect(answers[0]).toBe("1–3 hours");
    expect(answers[1]).toBe("4 / 5");
    expect(answers[2]).toBe("Yes");
  });

  it("writes image answers as bare URLs, not the markdown the embed uses", () => {
    const [row] = buildSubmissionExport(form, submissions, { usernames }).rows;
    expect(row[row.length - 1]).toBe(
      "https://res.cloudinary.com/c/a.png\nhttps://res.cloudinary.com/c/b.png"
    );
  });

  it("resolves usernames and falls back rather than attributing to nobody", () => {
    const { rows } = buildSubmissionExport(
      form,
      [{ ...submissions[0], userId: 99 }],
      { usernames }
    );
    expect(rows[0][1]).toBe("User #99");
  });

  it("writes timestamps as ISO 8601", () => {
    const [row] = buildSubmissionExport(form, submissions, { usernames }).rows;
    expect(row[2]).toBe("2026-09-22T10:00:00.000Z");
    expect(row[5]).toBe("");
  });

  it("copes with a form nobody has submitted, and with no form", () => {
    expect(buildSubmissionExport(form, [], { usernames }).rows).toEqual([]);
    expect(buildSubmissionExport(null, []).columns).toEqual(META_COLUMNS);
  });

  it("leaves a missing answer blank rather than undefined", () => {
    const { rows } = buildSubmissionExport(form, [{ submissionId: 2, userId: 42, answers: {} }], {
      usernames,
    });
    expect(rows[0].slice(META_COLUMNS.length)).toEqual(["", "", "No", ""]);
  });
});
