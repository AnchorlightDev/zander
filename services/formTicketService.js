/**
 * services/formTicketService.js
 *
 * Opens a support ticket for a form submission, and keeps that ticket updated
 * as the submission is reviewed.
 *
 * The point is to stop a submission being a dead drop. Without this, someone
 * fills in an application and hears nothing until a staff member remembers to
 * tell them; with it, the submitter gets a thread they can already see, staff
 * can reply in it, and the approve/deny decision is posted there automatically.
 *
 * Every export is best-effort. The submission (or the review) is committed
 * before any of this runs, so a Discord outage, a missing guild config or a
 * deleted category must never turn a saved submission into a user-facing
 * error. Failures are logged and swallowed.
 */

import { client } from "../controllers/discordController.js";
import {
  createSupportTicket,
  createSupportTicketMessage,
  ensureUncategorisedCategory,
  getCategoryDiscordParentId,
  getCategoryPermissions,
  syncParticipantsForMessage,
} from "../controllers/supportTicketController.js";
import { formatAnswer } from "../lib/formFields.js";

/** Render the submitted answers as the ticket's opening message. */
function buildOpeningMessage({ form, fields, answers, submissionId }) {
  const lines = [`${form.name} - submission #${submissionId}`, ""];

  for (const field of fields) {
    const value = formatAnswer(field, answers[field.fieldKey]);
    lines.push(`${field.label}:`);
    lines.push(value || "(not answered)");
    lines.push("");
  }

  lines.push("A staff member will review this and reply here.");
  return lines.join("\n");
}

/**
 * Open a ticket for a freshly created submission.
 *
 * Returns the new ticketId, or null when no ticket was opened (option off,
 * Discord unavailable, or creation failed).
 */
export async function openTicketForSubmission({ form, fields, answers, submissionId, user }) {
  if (!form?.createTicket) return null;

  if (!client?.isReady?.()) {
    console.warn("[forms] Discord client not ready; no ticket opened for submission", submissionId);
    return null;
  }

  try {
    // A form whose category was deleted falls back to Uncategorised rather
    // than failing to open a ticket at all.
    const categoryId = form.ticketCategoryId || (await ensureUncategorisedCategory());
    const [staffRoleIds, parentCategoryId] = await Promise.all([
      getCategoryPermissions(categoryId).catch(() => []),
      getCategoryDiscordParentId(categoryId).catch(() => null),
    ]);

    const ticket = await createSupportTicket(
      client,
      user.userId,
      categoryId,
      `${form.name} - submission #${submissionId}`,
      {
        discordUserId: user.discordId ?? null,
        staffRoleIds,
        parentCategoryId,
      }
    );

    // skipDiscordPost: createSupportTicket already pins an opener in the new
    // channel, so re-posting the body would duplicate it.
    await createSupportTicketMessage(
      client,
      ticket.ticketId,
      user.userId,
      buildOpeningMessage({ form, fields, answers, submissionId }),
      "web",
      { skipDiscordPost: true }
    );

    await syncParticipantsForMessage(client, ticket.ticketId, {
      userId: user.userId,
      rankSlugs: user.ranks?.map((rank) => rank.rankSlug) || [],
    });

    return ticket.ticketId;
  } catch (error) {
    console.error("[forms] Failed to open ticket for submission", submissionId, error);
    return null;
  }
}

const DECISION_TEXT = {
  approved: "Your submission has been **approved**.",
  denied: "Your submission has been **denied**.",
  pending: "Your submission has been put back to **pending** and is being looked at again.",
};

/**
 * Post a review decision into the submission's ticket.
 *
 * `reviewNotes` are the reviewer's internal notes, so they are deliberately
 * NOT included -- only the decision itself reaches the submitter.
 */
export async function postReviewToTicket({ submission, status, reviewer }) {
  if (!submission?.ticketId) return false;

  if (!client?.isReady?.()) {
    console.warn("[forms] Discord client not ready; review not posted to ticket", submission.ticketId);
    return false;
  }

  try {
    const body = [
      DECISION_TEXT[status] ?? `Your submission status is now **${status}**.`,
      reviewer ? `\nReviewed by ${reviewer}.` : "",
    ].join("");

    await createSupportTicketMessage(
      client,
      submission.ticketId,
      submission.reviewedBy ?? submission.userId,
      body,
      "web",
      { messageType: "message" }
    );
    return true;
  } catch (error) {
    console.error("[forms] Failed to post review to ticket", submission.ticketId, error);
    return false;
  }
}
