/**
 * lib/csv.mjs
 *
 * Building CSV from untrusted text.
 *
 * Imports nothing, so it is unit-testable on its own.
 *
 * Two things matter here beyond commas and quotes:
 *
 *   Formula injection. A spreadsheet treats a cell beginning =, +, - or @ as a
 *   formula and will happily run it -- including things like
 *   =HYPERLINK(...) or a DDE call -- when a staff member opens the file. Form
 *   answers are typed by the public, so every export of them is a delivery
 *   mechanism unless the cells are neutralised. See guard().
 *
 *   Excel and UTF-8. Excel assumes the system codepage for a .csv unless the
 *   file opens with a byte-order mark, which turns any non-ASCII answer into
 *   mojibake. toCsv can prepend one.
 */

/** Cells opening with one of these are read as formulas by Excel and Sheets. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralise a cell a spreadsheet would execute.
 *
 * Prefixing with an apostrophe is the standard mitigation: the spreadsheet
 * shows the original text and treats it as literal.
 *
 * Plain numbers are left alone. "-5" and "+3" trip the same test as a formula
 * but are obviously data, and quoting every negative number in a column of
 * figures would make the export worse at the job it exists for.
 */
function guard(text) {
  if (!FORMULA_START.test(text)) return text;
  if (Number.isFinite(Number(text))) return text;
  return `'${text}`;
}

/** One cell: guarded, then quoted if it contains anything structural. */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return "";

  const text = guard(String(value));

  // A quote inside a quoted field is written doubled, per RFC 4180.
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Rows to CSV text.
 *
 * CRLF line endings, because that is what RFC 4180 specifies and what Excel is
 * least surprised by.
 *
 * @param {object}   table
 * @param {string[]} table.columns  header row
 * @param {Array[]}  table.rows     one array of cells per row
 * @param {boolean}  [bom]          prepend a UTF-8 BOM for Excel. Default true.
 */
export function toCsv({ columns = [], rows = [] } = {}, { bom = true } = {}) {
  const lines = [];

  if (columns.length) lines.push(columns.map(escapeCsvCell).join(","));
  for (const row of rows) lines.push((row ?? []).map(escapeCsvCell).join(","));

  return (bom ? "﻿" : "") + lines.join("\r\n");
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Anything outside a conservative set is collapsed to a hyphen, so a form
 * called `Report "2026", v2` cannot break out of the quoted header value.
 */
export function csvFilename(...parts) {
  const base = parts
    .filter(Boolean)
    .map((part) => String(part).trim().replace(/[^A-Za-z0-9._-]+/g, "-"))
    .filter(Boolean)
    .join("-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return `${base || "export"}.csv`;
}
