/**
 * services/formDiscordService.js
 *
 * Posts new form submissions to a Discord channel.
 *
 * Every export here is best-effort: a form submission is already committed by
 * the time this runs, so a missing channel, a not-ready client or a revoked
 * permission must never turn a successful submission into an error for the
 * person who filled the form in. Failures are logged and swallowed.
 */

import { ChannelType, EmbedBuilder } from "discord.js";
import { client } from "../controllers/discordController.js";
import { formatAnswer, getAnswerImages, isDisplayType } from "../lib/formFields.js";
import { parseDiscordIds } from "../lib/discordIds.mjs";

const STATUS_COLOURS = {
  pending: 0x5865f2,
  approved: 0x57f287,
  denied: 0xed4245,
};

/**
 * Discord embeds cap at 25 fields and 1024 characters per field value, so long
 * paragraph answers are truncated rather than rejected by the API.
 */
function buildSubmissionEmbed({ form, fields, answers, submissionId, submitter }) {
  const embed = new EmbedBuilder()
    .setTitle(`New submission: ${form.name}`)
    .setColor(STATUS_COLOURS.pending)
    .setFooter({ text: `Submission #${submissionId}` })
    .setTimestamp(new Date());

  if (submitter) {
    embed.setAuthor({ name: submitter });
  }

  // Section breaks are page furniture on the public form; they have no answer,
  // so they are not rows in the review embed either.
  const answerable = fields.filter((field) => !isDisplayType(field.fieldType));
  const shown = answerable.slice(0, 25);
  let previewImage = null;

  for (const field of shown) {
    let text = formatAnswer(field, answers[field.fieldKey]) || "*(blank)*";
    if (text.length > 1024) text = `${text.slice(0, 1021)}...`;
    embed.addFields({ name: String(field.label).slice(0, 256), value: text });

    // An embed has room for exactly one image, so the first uploaded image
    // on the form gets it; the rest stay as the links formatAnswer produced.
    if (!previewImage) {
      previewImage = getAnswerImages(field, answers[field.fieldKey])[0]?.url ?? null;
    }
  }

  if (previewImage) embed.setImage(previewImage);

  if (answerable.length > shown.length) {
    embed.setDescription(
      `Showing the first ${shown.length} of ${answerable.length} answers - open the dashboard for the rest.`
    );
  }

  return embed;
}

/** Point the embed title at the dashboard, when we know our own address. */
function linkToDashboard(embed, submissionId, siteAddress) {
  if (!siteAddress) return embed;
  return embed.setURL(`${siteAddress}/dashboard/forms/submissions/view?submissionId=${submissionId}`);
}

/**
 * Announce a new submission.
 *
 * Returns the Discord message id on success, or null when nothing was sent
 * (no channel configured, client not ready, or the send failed).
 */
export async function notifyNewSubmission({ form, fields, answers, submissionId, submitter, siteAddress }) {
  const channelId = form?.discordChannelId;
  if (!channelId) return null;

  if (!client?.isReady?.()) {
    console.warn("[forms] Discord client not ready; skipping submission notification.");
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      console.warn(`[forms] Channel ${channelId} is not text-based; skipping notification.`);
      return null;
    }

    const embed = buildSubmissionEmbed({ form, fields, answers, submissionId, submitter });
    linkToDashboard(embed, submissionId, siteAddress);

    const message = await channel.send({ embeds: [embed] });
    return message.id;
  } catch (error) {
    console.error("[forms] Failed to post submission to Discord:", error.message);
    return null;
  }
}

/**
 * Open a thread for this submission in a Discord forum channel.
 *
 * A forum gives every submission a thread of its own, so the back-and-forth
 * about one applicant stays attached to that applicant instead of scrolling
 * away in a shared channel. Independent of `discordChannelId` -- a form can
 * use either, both or neither.
 *
 * Returns the new thread id, or null when nothing was created.
 */
export async function postSubmissionToForum({
  form, fields, answers, submissionId, submitter, siteAddress,
}) {
  const channelId = form?.discordForumChannelId;
  if (!channelId) return null;

  if (!client?.isReady?.()) {
    console.warn("[forms] Discord client not ready; skipping forum post.");
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildForum) {
      console.warn(`[forms] Channel ${channelId} is not a forum channel; skipping forum post.`);
      return null;
    }

    const embed = buildSubmissionEmbed({ form, fields, answers, submissionId, submitter });
    linkToDashboard(embed, submissionId, siteAddress);

    const thread = await channel.threads.create({
      // Discord caps thread names at 100 characters.
      name: `${submitter || "Submission"} - #${submissionId}`.slice(0, 100),
      message: { embeds: [embed] },
      reason: `Form submission #${submissionId}`,
    });

    return thread.id;
  } catch (error) {
    console.error("[forms] Failed to open forum thread:", error.message);
    return null;
  }
}

/**
 * DM the people listed on the form that a submission has landed.
 *
 * For forms nobody is sitting watching a channel for. Returns how many DMs
 * actually went out.
 *
 * A closed DM is an ordinary outcome, not an error worth shouting about: plenty
 * of people have DMs off, and the submission is already saved either way.
 */
export async function dmNewSubmission({
  form, fields, answers, submissionId, submitter, siteAddress,
}) {
  const recipients = parseDiscordIds(form?.notifyDiscordUserIds);
  if (!recipients.length) return 0;

  if (!client?.isReady?.()) {
    console.warn("[forms] Discord client not ready; skipping submission DMs.");
    return 0;
  }

  const embed = buildSubmissionEmbed({ form, fields, answers, submissionId, submitter });
  linkToDashboard(embed, submissionId, siteAddress);

  let sent = 0;
  for (const id of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const user = await client.users.fetch(id);
      // eslint-disable-next-line no-await-in-loop
      await user.send({ embeds: [embed] });
      sent += 1;
    } catch (error) {
      if (error.code === 50007) continue; // recipient has DMs closed
      console.error(`[forms] Failed to DM ${id} about submission ${submissionId}:`, error.message);
    }
  }

  return sent;
}

/**
 * Post the decision into the submission's own forum thread.
 *
 * Without this the thread stops at "here is the application" and never says
 * what happened to it, which is exactly the thing a thread per submission was
 * meant to fix.
 */
export async function postReviewToThread({ submission, status, reviewer }) {
  const threadId = submission?.discordThreadId;
  if (!threadId || !client?.isReady?.()) return false;

  try {
    const thread = await client.channels.fetch(threadId);
    if (!thread?.isThread?.()) return false;

    const embed = new EmbedBuilder()
      .setTitle(`Submission #${submission.submissionId} ${status}`)
      .setColor(STATUS_COLOURS[status] ?? STATUS_COLOURS.pending)
      .setTimestamp(new Date());

    if (reviewer) embed.setDescription(`Reviewed by ${reviewer}.`);

    await thread.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error("[forms] Failed to post review to thread:", error.message);
    return false;
  }
}

/**
 * Follow up on the original announcement once a submission is reviewed, so the
 * channel does not keep showing a decided submission as pending.
 */
export async function notifySubmissionReviewed({ form, submissionId, status, reviewer }) {
  const channelId = form?.discordChannelId;
  if (!channelId || !client?.isReady?.()) return null;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return null;

    const embed = new EmbedBuilder()
      .setTitle(`Submission #${submissionId} ${status}`)
      .setDescription(`**${form.name}**${reviewer ? ` - reviewed by ${reviewer}` : ""}`)
      .setColor(STATUS_COLOURS[status] ?? STATUS_COLOURS.pending)
      .setTimestamp(new Date());

    const message = await channel.send({ embeds: [embed] });
    return message.id;
  } catch (error) {
    console.error("[forms] Failed to post review update to Discord:", error.message);
    return null;
  }
}
