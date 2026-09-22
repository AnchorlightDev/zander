/**
 * lib/formAccess.mjs
 *
 * The shared passcode gate on a form.
 *
 * Imports only node:crypto -- no database, no config -- so the comparison is
 * unit-testable on its own.
 *
 * Deliberately not here: any lockout, throttle or attempt counter. A wrong code
 * is rejected plainly and the visitor may try again immediately. The code is a
 * pasteable shared secret handed out in an announcement, not a credential, and
 * a lockout on a shared secret mostly locks out the people who were given it.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * SHA-256 of the candidate.
 *
 * Hashing first is what makes the comparison genuinely constant-time:
 * timingSafeEqual throws unless both buffers are the same length, so comparing
 * the raw strings would mean either a length check that returns early (leaking
 * the code's length through timing) or padding. Two digests are always 32
 * bytes, whatever went in.
 */
function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

/** Does this form have a passcode set at all? Blank or NULL means no gate. */
export function requiresAccessCode(form) {
  return String(form?.accessCode ?? "").trim().length > 0;
}

/**
 * Is `supplied` the form's code?
 *
 * Returns false when the form has no code, rather than waving the caller
 * through: whether a gate exists is requiresAccessCode's question, and failing
 * closed here means forgetting to ask it cannot open the form.
 */
export function verifyAccessCode(stored, supplied) {
  const expected = String(stored ?? "").trim();
  if (!expected) return false;

  const given = String(supplied ?? "").trim();
  if (!given) return false;

  return timingSafeEqual(digest(expected), digest(given));
}

/**
 * Has this session already entered the code for this form?
 *
 * Remembered per slug so a validation error part-way through a long form does
 * not send the applicant back to the code prompt with their answers gone.
 */
export function hasUnlocked(session, slug) {
  return Boolean(session?.formAccess?.[String(slug)]);
}

/** Record that this session entered the right code for this form. */
export function markUnlocked(session, slug) {
  if (!session) return;
  if (!session.formAccess || typeof session.formAccess !== "object") {
    session.formAccess = {};
  }
  session.formAccess[String(slug)] = true;
}
