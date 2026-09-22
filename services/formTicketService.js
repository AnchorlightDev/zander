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
import { buildTicketMessage } from "../lib/formTicketMessages.mjs";

/**
 * Render the submitted answers as the ticket's opening message.
 *
 * The opening message is also the "pending" post in the status thread -- the
 * ticket only exists because the submission landed, so a separate message
 * saying so would just be noise directly under this one.
 */
function buildOpeningMessage({ form, fields, answers, submissionId }) {
  const lines = [`${form.name} - submission #${submissionId}`, ""];

  for (const field of fields) {
    const value = formatAnswer(field, answers[field.fieldKey]);
    lines.push(`${field.label}:`);
    lines.push(value || "(not answered)");
    lines.push("");
  }

  lines.push(buildTicketMessage("pending", { form, submissionId }));
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

/**
 * Post a review decision into the submission's ticket.
 *
 * The wording comes from the form, so each form can phrase its own approval
 * and rejection; lib/formTicketMessages.mjs supplies the defaults.
 *
 * The reviewer's comment is included, but only when the submission is flagged
 * commentIsPublic. Notes stored before that flag existed were written under an
 * internal-only labelling and stay internal -- see migration
 * 0053_form_ticket_messages.
 */
export async function postReviewToTicket({ submission, status, reviewer }) {
  if (!submission?.ticketId) return false;

  if (!client?.isReady?.()) {
    console.warn("[forms] Discord client not ready; review not posted to ticket", submission.ticketId);
    return false;
  }

  try {
    // "pending" here means a decision was undone, which is not what the
    // pending wording says -- that one opens the ticket when it first lands.
    const messageKey = status === "pending" ? "reopened" : status;

    const body =
      buildTicketMessage(messageKey, {
        form: submission.form,
        submissionId: submission.submissionId,
        reviewer,
        comment: submission.reviewNotes,
        commentIsPublic: submission.commentIsPublic,
      }) ?? `Your submission status is now **${status}**.`;

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
