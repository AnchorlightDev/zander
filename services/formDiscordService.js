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

import { EmbedBuilder } from "discord.js";
import { client } from "../controllers/discordController.js";
import { formatAnswer, getAnswerImages, isDisplayType } from "../lib/formFields.js";

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
    if (siteAddress) {
      embed.setURL(`${siteAddress}/dashboard/forms/submissions/view?submissionId=${submissionId}`);
    }

    const message = await channel.send({ embeds: [embed] });
    return message.id;
  } catch (error) {
    console.error("[forms] Failed to post submission to Discord:", error.message);
    return null;
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
