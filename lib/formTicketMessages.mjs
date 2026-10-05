/**
 * lib/formTicketMessages.mjs
 *
 * What gets posted into a submission's support ticket at each stage.
 *
 * Where a form opens a ticket, that ticket is the applicant's view of the
 * whole process: it opens when the submission lands, and the decision is
 * posted into the same thread. Each form supplies its own wording, because a
 * Builder rejection and a staff rejection should not read the same.
 *
 * Imports nothing, so the templating is testable without a Discord client or
 * a database.
 */

/**
 * Used when a form leaves its wording blank, which is every form until
 * somebody edits one.
 */
export const DEFAULT_TICKET_MESSAGES = {
  pending:
    "Thanks — your submission has been received and is waiting to be reviewed. " +
    "We will post the outcome in this ticket, so keep an eye here.",
  approved: "Good news — your submission has been **approved**.",
  denied: "Your submission has not been successful this time.",
  // For a form that is not reviewed at all. `pending` promises an outcome,
  // which would be a lie on a feedback survey.
  received:
    "Thanks \u2014 your response has been recorded. There is nothing further you need to do.",
  // A decision being undone. Distinct from `pending`, which is the message
  // that opens the ticket -- "your submission has been received" would read
  // very oddly posted under an approval.
  reopened: "Your submission has been put back to **pending** and is being looked at again.",
};

/**
 * Which `forms` column overrides each default.
 *
 * `reopened` has no column: it is a rare correction rather than part of the
 * applicant-facing flow, so it is not worth a fourth textarea in the editor.
 */
export const TICKET_MESSAGE_FIELDS = {
  pending: "ticketPendingMessage",
  // Shares the pending column: it is the same slot in the editor, just worded
  // for a form nobody is going to decide on.
  received: "ticketPendingMessage",
  approved: "ticketApprovedMessage",
  denied: "ticketDeniedMessage",
  reopened: null,
};

/**
 * Substitute the handful of placeholders a form's wording may use.
 *
 * Deliberately a small fixed set rather than a template language: this text is
 * edited in a dashboard textarea by people who are not writing code, and an
 * unknown placeholder should survive as literal text rather than blow up.
 */
function fill(template, values) {
  return String(template).replace(/\{(form|submissionId|reviewer)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === "" ? match : String(value);
  });
}

/**
 * The body to post for a submission at `status`.
 *
 * `comment` is the reviewer's note. It is only ever included when
 * `commentIsPublic` is true -- notes stored before that column existed were
 * written under an internal-only labelling, and must not be published
 * retroactively just because the feature changed.
 *
 * Returns null for a status with nothing to say.
 */
export function buildTicketMessage(status, options = {}) {
  const {
    form = null,
    submissionId = null,
    reviewer = null,
    comment = null,
    commentIsPublic = false,
  } = options;

  if (!(status in TICKET_MESSAGE_FIELDS)) return null;

  const field = TICKET_MESSAGE_FIELDS[status];
  const configured = field ? String(form?.[field] ?? "").trim() : "";
  const template = configured || DEFAULT_TICKET_MESSAGES[status];

  const parts = [
    fill(template, {
      form: form?.name ?? null,
      submissionId,
      reviewer,
    }),
  ];

  // Only a decision has a reviewer worth naming. Both opening messages --
  // `pending` and `received` -- are posted before anyone has looked at it, so
  // the test is positive rather than "anything but pending": adding a fourth
  // status should not silently start naming somebody.
  const isDecision = status === "approved" || status === "denied";
  const namesReviewer = isDecision || status === "reopened";

  if (namesReviewer && reviewer) {
    parts.push(`Reviewed by ${reviewer}.`);
  }

  const trimmed = String(comment ?? "").trim();
  if (isDecision && commentIsPublic && trimmed) {
    parts.push(`**Comment from the reviewer:**\n${trimmed}`);
  }

  return parts.join("\n\n");
}
