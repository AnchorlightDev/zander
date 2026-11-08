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

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { client } from "../controllers/discordController.js";
import {
  createSupportTicket,
  createSupportTicketMessage,
  ensureUncategorisedCategory,
  getCategoryDiscordParentId,
  getCategoryPermissions,
  syncParticipantsForMessage,
} from "../controllers/supportTicketController.js";
import { formatAnswer, isDisplayType } from "../lib/formFields.js";
import { buildSubmissionEmbed } from "./formDiscordService.js";
import { buildTicketMessage } from "../lib/formTicketMessages.mjs";

/**
 * Post the opening embed into the freshly created ticket channel, and pin it.
 *
 * createSupportTicket only creates and links the channel -- it does not post
 * anything -- and the ticket's stored opening message is written with
 * skipDiscordPost so it never reaches Discord. So unless we post here, an
 * application ticket's channel opens completely blank. Every other ticket flow
 * (the /support command and the contact form) posts its own opener the same way.
 *
 * Best-effort: the ticket and its stored message already exist, so a failed or
 * blocked send must not undo them.
 */
async function postOpenerToChannel(channel, { form, fields, answers, submissionId, submitter, ticketId, siteAddress }) {
  if (!channel?.send) return;

  try {
    const embed = buildSubmissionEmbed({ form, fields, answers, submissionId, submitter });

    const components = [];
    if (siteAddress && ticketId) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("View Ticket Online")
            .setURL(`${String(siteAddress).replace(/\/+$/, "")}/support/ticket/${ticketId}`)
        )
      );
    }

    const sent = await channel.send({ embeds: [embed], components });
    await sent.pin().catch(() => {});
  } catch (error) {
    console.error("[forms] Could not post the ticket opener to Discord:", error.message);
  }
}

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
    if (isDisplayType(field.fieldType)) continue;
    const value = formatAnswer(field, answers[field.fieldKey]);
    lines.push(`${field.label}:`);
    lines.push(value || "(not answered)");
    lines.push("");
  }

  // A form nobody reviews must not open its ticket promising a decision.
  const opening = form?.requiresReview === false ? "received" : "pending";
  lines.push(buildTicketMessage(opening, { form, submissionId }));
  return lines.join("\n");
}

/**
 * Open a ticket for a freshly created submission.
 *
 * Returns the new ticketId, or null when no ticket was opened (option off,
 * Discord unavailable, or creation failed).
 */
export async function openTicketForSubmission({ form, fields, answers, submissionId, user, siteAddress }) {
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

    const { ticketId, channel } = await createSupportTicket(
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

    // skipDiscordPost: we post the opener embed ourselves below, so letting
    // createSupportTicketMessage also post the body would duplicate it. The
    // stored message is still what the website ticket page renders.
    await createSupportTicketMessage(
      client,
      ticketId,
      user.userId,
      buildOpeningMessage({ form, fields, answers, submissionId }),
      "web",
      { skipDiscordPost: true }
    );

    // createSupportTicket only creates the channel; without this the ticket
    // opens with no message at all. Best-effort, like everything else here.
    await postOpenerToChannel(channel, {
      form,
      fields,
      answers,
      submissionId,
      submitter: user.username,
      ticketId,
      siteAddress,
    });

    await syncParticipantsForMessage(client, ticketId, {
      userId: user.userId,
      rankSlugs: user.ranks?.map((rank) => rank.rankSlug) || [],
    });

    return ticketId;
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
