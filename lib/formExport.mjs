/**
 * lib/formExport.mjs
 *
 * Turning a form's submissions into a table.
 *
 * Kept separate from the route so the shape of the export -- which columns, in
 * what order, and how each answer is written -- can be tested without a
 * database. Imports only lib/formFields.js, which imports nothing.
 *
 * One column per question, in the order the form asks them, using the question
 * label as the header. Answers go through the same formatter the dashboard and
 * the Discord embed use, so a reviewer reading the spreadsheet sees what they
 * would have seen on screen -- option labels rather than stored values, Yes/No
 * rather than a raw boolean.
 */

import { formatAnswer, getAnswerImages, getFieldType, isDisplayType } from "./formFields.js";

/** Columns that describe the submission itself, before the answers. */
export const META_COLUMNS = [
  "Submission ID",
  "Submitted by",
  "Received",
  "Status",
  "Reviewed by",
  "Reviewed at",
  "Reviewer comment",
];

/** ISO 8601, which spreadsheets and humans both read unambiguously. */
function stamp(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/**
 * One answer as a spreadsheet cell.
 *
 * Differs from the on-screen formatter in one place: image fields render as
 * markdown links for Discord, which is noise in a cell. Here they are the bare
 * URLs, one per line, so they stay clickable and copyable.
 */
export function formatAnswerForExport(field, value) {
  if (getFieldType(field?.fieldType)?.value === "images") {
    return getAnswerImages(field, value)
      .map((image) => image.url)
      .join("\n");
  }
  return formatAnswer(field, value);
}

/**
 * Build the table for one form's submissions.
 *
 * `usernames` maps userId to display name; anything missing falls back to the
 * numeric id so a row is never silently attributed to nobody.
 *
 * Section breaks and other display-only fields are skipped -- they are page
 * furniture and have no answer to put in a column.
 */
export function buildSubmissionExport(form, submissions = [], { usernames = new Map() } = {}) {
  const questions = (form?.fields ?? [])
    .filter((field) => !isDisplayType(field.fieldType))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const columns = [...META_COLUMNS, ...questions.map((field) => field.label || field.fieldKey)];

  const nameFor = (userId) =>
    userId === null || userId === undefined ? "" : usernames.get(userId) ?? `User #${userId}`;

  const rows = submissions.map((submission) => {
    const answers = submission.answers ?? {};

    return [
      submission.submissionId,
      nameFor(submission.userId),
      stamp(submission.createdAt),
      submission.status ?? "",
      submission.reviewedBy ? nameFor(submission.reviewedBy) : "",
      stamp(submission.reviewedAt),
      submission.reviewNotes ?? "",
      ...questions.map((field) => formatAnswerForExport(field, answers[field.fieldKey])),
    ];
  });

  return { columns, rows };
}
