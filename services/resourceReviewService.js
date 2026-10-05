/**
 * services/resourceReviewService.js
 *
 * The review flow for community resources.
 *
 *   submit   → a pending resource with a deadline, posted to the review
 *              channel (Settings → Pages & Resources) with Approve/Reject
 *              buttons
 *   vote     → from those buttons (listeners/resourceReviewInteractions.js)
 *              or the dashboard; both land here and count the same
 *   decide   → automatically once a majority of reviewers agree
 *              (lib/resources.mjs), or by hand once overdue
 *   notify   → the review message is updated and the submitter is DMed
 *
 * cron/resourceReviewCron.js calls sweepPendingResources() to re-count
 * (the reviewer list can change) and to flag submissions as overdue once.
 */

import { createRequire } from "module";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from "discord.js";
import { client } from "../controllers/discordController.js";
import {
  createResource,
  findDuplicate,
  getResourceById,
  getReviewerIds,
  listCategories,
  listPendingResources,
  markDecided,
  updateResource,
  upsertVote,
} from "../controllers/resourceController.js";
import {
  VOTES,
  deadlineFrom,
  decideOutcome,
  isOverdue,
  parseResource,
  tallyVotes,
} from "../lib/resources.mjs";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");

export const VOTE_BUTTON_PREFIX = "resource_vote";

const siteAddress = () => String(process.env.siteAddress || "").replace(/\/+$/, "");
const discordTime = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

const STATUS_STYLE = {
  pending: { color: Colors.Gold, label: "Awaiting votes" },
  overdue: { color: Colors.Orange, label: "Overdue — needs a manual decision" },
  approved: { color: Colors.Green, label: "Approved" },
  rejected: { color: Colors.Red, label: "Rejected" },
};

function buildReviewMessage(resource, tally) {
  const state = resource.status === "pending" && isOverdue(resource) ? "overdue" : resource.status;
  const style = STATUS_STYLE[state];

  const embed = new EmbedBuilder()
    .setTitle(`Resource suggestion: ${resource.title}`.slice(0, 256))
    .setURL(resource.url)
    .setDescription(resource.description.slice(0, 1000))
    .setColor(style.color)
    .addFields(
      { name: "Category", value: resource.category?.name || "—", inline: true },
      { name: "Submitted by", value: (resource.submittedByName || "Unknown").slice(0, 100), inline: true },
      { name: "Status", value: style.label, inline: true },
      {
        name: "Votes",
        value: `👍 ${tally.approve} · 👎 ${tally.reject} — ${tally.needed} of ${tally.eligible} reviewer(s) needed`,
        inline: false,
      },
      { name: "Link", value: resource.url.slice(0, 1024), inline: false }
    )
    .setFooter({ text: `Resource #${resource.resourceId}` });

  if (resource.status === "pending" && resource.deadlineAt) {
    embed.addFields({ name: "Deadline", value: discordTime(resource.deadlineAt), inline: true });
  }

  const row = new ActionRowBuilder();
  if (resource.status === "pending") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`${VOTE_BUTTON_PREFIX}:approve:${resource.resourceId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${VOTE_BUTTON_PREFIX}:reject:${resource.resourceId}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
    );
  }
  if (siteAddress()) {
    row.addComponents(
      new ButtonBuilder().setLabel("Open in dashboard").setStyle(ButtonStyle.Link).setURL(`${siteAddress()}/dashboard/resources`)
    );
  }

  return { embeds: [embed], components: row.components.length ? [row] : [] };
}

async function fetchReviewChannel(channelId) {
  if (!channelId || !client?.isReady?.()) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.isTextBased?.() ? channel : null;
  } catch (error) {
    console.error(`[resources] Could not open review channel ${channelId}:`, error.message);
    return null;
  }
}

/** Post (first time) or refresh the review message. Never throws. */
async function syncReviewMessage(resource, tally) {
  try {
    const payload = buildReviewMessage(resource, tally);
    if (resource.reviewChannelId && resource.reviewMessageId) {
      const channel = await fetchReviewChannel(resource.reviewChannelId);
      const message = await channel?.messages.fetch(resource.reviewMessageId).catch(() => null);
      if (message) {
        await message.edit(payload);
        return;
      }
    }
    if (resource.status !== "pending") return;

    const channelId = config.resources?.reviewChannelId;
    const channel = await fetchReviewChannel(channelId);
    if (!channel) return;
    const message = await channel.send(payload);
    await updateResource(resource.resourceId, { reviewChannelId: channel.id, reviewMessageId: message.id });
  } catch (error) {
    console.error(`[resources] Could not update the review message for #${resource.resourceId}:`, error.message);
  }
}

async function notifySubmitter(resource) {
  if (!resource.submittedByDiscordId || !client?.isReady?.()) return;
  const approved = resource.status === "approved";
  try {
    const user = await client.users.fetch(resource.submittedByDiscordId);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(approved ? "Your resource was approved" : "Your resource was not approved")
          .setDescription(
            approved
              ? `Thanks! **${resource.title}** is now listed on ${siteAddress()}/resources.`
              : `Staff reviewed **${resource.title}** and decided not to add it this time. Thank you for the suggestion.`
          )
          .setColor(approved ? Colors.Green : Colors.Red),
      ],
    });
  } catch (error) {
    // DMs closed is normal; nothing else to do.
    console.warn(`[resources] Could not DM the submitter of #${resource.resourceId}: ${error.message}`);
  }
}

async function tallyFor(resource) {
  return tallyVotes(resource.votes, await getReviewerIds());
}

/** Apply the vote outcome if one has been reached. */
async function settleIfDecided(resource) {
  const tally = await tallyFor(resource);
  const outcome = decideOutcome(tally);
  if (!outcome) return { resource, tally, decided: false };

  const decided = await markDecided(resource.resourceId, { status: outcome, method: "vote" });
  if (!decided) {
    const current = await getResourceById(resource.resourceId);
    return { resource: current, tally, decided: current?.status !== "pending" };
  }
  console.log(`[resources] #${decided.resourceId} "${decided.title}" ${outcome} by vote (${tally.approve}/${tally.reject} of ${tally.eligible}).`);
  await syncReviewMessage(decided, tally);
  await notifySubmitter(decided);
  return { resource: decided, tally, decided: true };
}

/**
 * Submit a resource for review.
 *
 * @param {object} input       { categoryId, title, description, url }
 * @param {object} submitter   { userId, name, discordId }  -- userId is required
 * @param {"web"|"discord"} source
 */
export async function submitResource(input, submitter, source) {
  if (!submitter?.userId) return { ok: false, errors: ["You need to sign in to submit a resource."] };

  const categories = await listCategories();
  const parsed = parseResource(input, categories.map((c) => c.categoryId));
  if (!parsed.ok) return parsed;

  const duplicate = await findDuplicate(parsed.value.url);
  if (duplicate) {
    return {
      ok: false,
      errors: [duplicate.status === "approved" ? "That link is already listed." : "That link has already been suggested and is waiting for review."],
    };
  }

  const now = new Date();
  const resource = await createResource({
    ...parsed.value,
    status: "pending",
    source,
    submittedByUserId: submitter.userId,
    submittedByDiscordId: submitter.discordId || null,
    submittedByName: String(submitter.name || "").slice(0, 100) || null,
    deadlineAt: deadlineFrom(now, config.resources?.voteWindowDays),
  });

  const tally = await tallyFor(resource).catch(() => ({ approve: 0, reject: 0, eligible: 0, needed: 1 }));
  await syncReviewMessage(resource, tally);
  console.log(`[resources] #${resource.resourceId} "${resource.title}" submitted by ${resource.submittedByName} (${source}).`);
  return { ok: true, resource };
}

/**
 * Record a reviewer's vote. The caller has already checked they hold
 * REVIEW_PERMISSION; votes from people who lose it later stop counting.
 */
export async function castVote(resourceId, userId, vote) {
  if (!VOTES.includes(vote)) return { ok: false, error: "Unknown vote." };
  const resource = await getResourceById(resourceId);
  if (!resource) return { ok: false, error: "That resource no longer exists." };
  if (resource.status !== "pending") return { ok: false, error: `This suggestion has already been ${resource.status}.` };

  // Use a fresh reviewer list for the voter so a newly granted reviewer counts at once.
  const reviewers = await getReviewerIds({ fresh: true });
  if (!reviewers.has(Number(userId))) {
    return { ok: false, error: "Your account is not on the resource reviewer list yet. Try again in a few minutes." };
  }

  await upsertVote(resource.resourceId, userId, vote);
  const updated = await getResourceById(resource.resourceId);
  const result = await settleIfDecided(updated);
  if (!result.decided) await syncReviewMessage(result.resource, result.tally);
  return { ok: true, ...result };
}

/** Staff decision on an overdue submission. */
export async function decideManually(resourceId, status, userId) {
  if (!["approved", "rejected"].includes(status)) return { ok: false, error: "Unknown decision." };
  const resource = await getResourceById(resourceId);
  if (!resource) return { ok: false, error: "That resource no longer exists." };
  if (resource.status !== "pending") return { ok: false, error: `This suggestion has already been ${resource.status}.` };
  if (!isOverdue(resource)) return { ok: false, error: "The vote is still open. It can be decided by hand once the deadline passes." };

  const decided = await markDecided(resource.resourceId, { status, method: "manual", decidedByUserId: userId });
  if (!decided) return { ok: false, error: "This suggestion was decided a moment ago." };
  await syncReviewMessage(decided, await tallyFor(decided).catch(() => tallyVotes([], new Set())));
  await notifySubmitter(decided);
  return { ok: true, resource: decided };
}

/** Re-count every pending submission and flag newly overdue ones once. */
export async function sweepPendingResources() {
  const pending = await listPendingResources();
  for (const resource of pending) {
    try {
      const result = await settleIfDecided(resource);
      if (result.decided) continue;

      if (isOverdue(resource) && !resource.overdueNotifiedAt) {
        const flagged = await updateResource(resource.resourceId, { overdueNotifiedAt: new Date() });
        await syncReviewMessage(flagged, result.tally);
        const channel = await fetchReviewChannel(flagged.reviewChannelId || config.resources?.reviewChannelId);
        await channel?.send({
          content: `⏰ The vote on **${flagged.title.slice(0, 100)}** closed without a majority. Someone with resource management access can decide it in the dashboard: ${siteAddress()}/dashboard/resources`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      console.error(`[resources] Sweep failed for #${resource.resourceId}:`, error.message);
    }
  }
}

export { tallyFor as getTally };
