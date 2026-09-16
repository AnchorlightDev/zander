/**
 * Meeting Poll Service
 *
 * Core CRUD and response recording for the Meetings module.  An organiser
 * proposes candidate time slots, the roster is expanded from LuckPerms ranks
 * (see services/meetingRosterService.js), and every invitee marks availability
 * against every slot.
 *
 * Phase one: no notification delivery, no send-time membership re-resolution,
 * no finalise -> event handoff, no 'open' audience mode.  Seams for those are
 * marked inline.
 */

import { prisma } from "../controllers/databaseController.js";
import { expandRanksToInvitees } from "./meetingRosterService.js";

export const POLL_STATUS = {
  OPEN: "open",
  FINALIZED: "finalized",
  CANCELLED: "cancelled",
};

export const AUDIENCE_MODE = {
  RANKS: "ranks",
  /** Town-hall poll anyone may answer.  Reserved — not implemented. */
  OPEN: "open",
};

export const AVAILABILITY = {
  YES: "yes",
  NO: "no",
  MAYBE: "maybe",
};

/**
 * Availability weights for ranking.  A 'no' contributes nothing rather than
 * penalising, so a slot nobody can make simply scores zero instead of going
 * negative and sorting below an unanswered slot.
 */
export const AVAILABILITY_WEIGHT = {
  [AVAILABILITY.YES]: 1,
  [AVAILABILITY.MAYBE]: 0.5,
  [AVAILABILITY.NO]: 0,
};

export const POLL_MIN_OPTIONS = 1;
export const POLL_MAX_OPTIONS = 30;

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate the organiser-supplied shape of a poll.  Returns a list of
 * human-readable errors; empty means valid.
 */
export function validatePollInput({ title, description, timezone, options, deadlineAt, audienceMode }) {
  const errors = [];

  const trimmedTitle = (title || "").trim();
  if (!trimmedTitle) {
    errors.push("Meeting title is required.");
  } else if (trimmedTitle.length > 255) {
    errors.push("Meeting title must be 255 characters or fewer.");
  }

  if (description && String(description).length > 5000) {
    errors.push("Meeting description must be 5000 characters or fewer.");
  }

  if (timezone && String(timezone).length > 64) {
    errors.push("Timezone must be 64 characters or fewer.");
  }

  if (audienceMode && audienceMode !== AUDIENCE_MODE.RANKS) {
    // 'open' is a reserved value with no implementation behind it yet; accepting
    // it here would create polls nobody can be resolved into.
    errors.push("Only rank-based meeting audiences are supported.");
  }

  if (!Array.isArray(options) || options.length < POLL_MIN_OPTIONS) {
    errors.push("At least one time option is required.");
  } else if (options.length > POLL_MAX_OPTIONS) {
    errors.push(`A meeting poll can have at most ${POLL_MAX_OPTIONS} time options.`);
  } else {
    options.forEach((option, index) => {
      const position = index + 1;
      const start = new Date(option?.startAt);
      const end = new Date(option?.endAt);

      if (!option?.startAt || isNaN(start.getTime())) {
        errors.push(`Option ${position}: a valid start time is required.`);
      }
      if (!option?.endAt || isNaN(end.getTime())) {
        errors.push(`Option ${position}: a valid end time is required.`);
      }
      if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end <= start) {
        errors.push(`Option ${position}: the end time must be after the start time.`);
      }
      if (option?.label && String(option.label).length > 255) {
        errors.push(`Option ${position}: the label must be 255 characters or fewer.`);
      }
    });
  }

  if (deadlineAt) {
    const deadline = new Date(deadlineAt);
    if (isNaN(deadline.getTime())) {
      errors.push("Invalid response deadline.");
    }
  }

  return errors;
}

function assertValid(input) {
  const errors = validatePollInput(input);
  if (errors.length > 0) throw new Error(errors.join(" "));
}

/** Normalise organiser-supplied options into rows, preserving given order. */
function toOptionRows(options) {
  return options.map((option, index) => ({
    startAt: new Date(option.startAt),
    endAt: new Date(option.endAt),
    label: option.label ? String(option.label).trim() : null,
    orderIndex: Number.isInteger(option.orderIndex) ? option.orderIndex : index,
  }));
}

// ============================================================================
// Ranking
// ============================================================================

/**
 * Score and order options by how many invitees can make them.
 *
 * Scored by weighted availability rather than raw response count, so a slot
 * with three 'yes' beats a slot with five responses that are mostly 'no'.
 *
 * Ties break on yes-count (a firm yes outranks the same score made of maybes),
 * then on fewer no's, then on the organiser's original ordering — so the result
 * is deterministic rather than dependent on row order.
 *
 * Pure: takes plain rows so it is unit-testable without a database.
 *
 * @param {{optionId: number, orderIndex?: number}[]} options
 * @param {{optionId: number, availability: string}[]} responses
 */
export function rankOptions(options, responses) {
  const tallies = new Map();
  for (const option of options) {
    tallies.set(option.optionId, { yes: 0, no: 0, maybe: 0 });
  }

  for (const response of responses) {
    const tally = tallies.get(response.optionId);
    // A response to an option that is no longer on the poll is ignored rather
    // than counted against a slot that does not exist.
    if (!tally) continue;
    if (response.availability in tally) tally[response.availability] += 1;
  }

  return options
    .map((option) => {
      const tally = tallies.get(option.optionId);
      const score =
        tally.yes * AVAILABILITY_WEIGHT[AVAILABILITY.YES] +
        tally.maybe * AVAILABILITY_WEIGHT[AVAILABILITY.MAYBE] +
        tally.no * AVAILABILITY_WEIGHT[AVAILABILITY.NO];

      return {
        ...option,
        yesCount: tally.yes,
        noCount: tally.no,
        maybeCount: tally.maybe,
        responseCount: tally.yes + tally.no + tally.maybe,
        score,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.yesCount - a.yesCount ||
        a.noCount - b.noCount ||
        (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
    );
}

// ============================================================================
// Reads
// ============================================================================

/**
 * List meeting polls for the dashboard.
 *
 * `inviteeUserId` restricts the list to polls that user is actually on, which
 * is how a non-manager sees only their own meetings.
 */
export async function getPolls({
  status = null,
  statuses = null,
  search = null,
  inviteeUserId = null,
  page = 1,
  limit = 50,
} = {}) {
  const where = {};

  if (statuses && statuses.length > 0) {
    where.status = { in: statuses };
  } else if (status) {
    where.status = status;
  }

  if (search) where.title = { contains: search };

  if (inviteeUserId) {
    where.invitees = { some: { userId: parseInt(inviteeUserId), removedAt: null } };
  }

  const [total, polls] = await Promise.all([
    prisma.meetingPolls.count({ where }),
    prisma.meetingPolls.findMany({
      where,
      include: {
        options: { orderBy: { orderIndex: "asc" } },
        roles: true,
        // Soft-removed invitees are excluded so the list count matches the
        // roster shown on the poll itself.
        _count: { select: { invitees: { where: { removedAt: null } } } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { total, polls, page, limit };
}

/**
 * A single poll with its options, roles, roster and responses, plus the ranked
 * option list and — when `viewerUserId` is given — that viewer's own answers.
 */
export async function getPollById(pollId, viewerUserId = null) {
  const poll = await prisma.meetingPolls.findUnique({
    where: { pollId: parseInt(pollId) },
    include: {
      options: { orderBy: { orderIndex: "asc" } },
      roles: true,
      invitees: { where: { removedAt: null } },
      responses: true,
    },
  });

  if (!poll) return null;

  const ranked = rankOptions(poll.options, poll.responses);

  // Invitee rows carry only userId; usernames come from the main DB so the
  // roster can be rendered without a second round-trip per row.
  const userIds = [...new Set(poll.invitees.map((invitee) => invitee.userId))];
  const users = userIds.length
    ? await prisma.users.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, username: true, uuid: true },
      })
    : [];
  const userById = new Map(users.map((user) => [user.userId, user]));

  const invitees = poll.invitees.map((invitee) => ({
    ...invitee,
    username: userById.get(invitee.userId)?.username || null,
    uuid: userById.get(invitee.userId)?.uuid || null,
    hasResponded: poll.responses.some((r) => r.userId === invitee.userId),
  }));
  invitees.sort((a, b) => (a.username || "").localeCompare(b.username || ""));

  const viewerId = viewerUserId ? parseInt(viewerUserId) : null;
  const viewerInvitee = viewerId
    ? invitees.find((invitee) => invitee.userId === viewerId) || null
    : null;

  const viewerResponses = viewerId
    ? poll.responses
        .filter((response) => response.userId === viewerId)
        .reduce((acc, response) => {
          acc[response.optionId] = response.availability;
          return acc;
        }, {})
    : {};

  return {
    ...poll,
    options: poll.options,
    ranked,
    invitees,
    respondedCount: new Set(poll.responses.map((r) => r.userId)).size,
    viewerIsInvitee: Boolean(viewerInvitee),
    viewerCanRespond:
      poll.status === POLL_STATUS.OPEN &&
      Boolean(viewerInvitee?.canRespond) &&
      !isPastDeadline(poll),
    viewerResponses,
  };
}

/** Whether the response deadline (if any) has passed. */
export function isPastDeadline(poll) {
  return Boolean(poll?.deadlineAt) && new Date(poll.deadlineAt) <= new Date();
}

/** Whether a user is a current (non-removed) invitee on a poll. */
export async function isInvitee(pollId, userId) {
  if (!userId) return false;
  const invitee = await prisma.meetingPollInvitees.findFirst({
    where: { pollId: parseInt(pollId), userId: parseInt(userId), removedAt: null },
  });
  return Boolean(invitee);
}

// ============================================================================
// Writes
// ============================================================================

/**
 * Create a poll, its options, its rank list and its initial roster.
 *
 * The roster is snapshotted here rather than derived on read, so the organiser
 * sees a stable list.  Re-resolving membership at notification time is a later
 * pass — refreshRoster() below is the seam for it.
 */
export async function createPoll(data, actorId) {
  assertValid(data);

  const rankSlugs = [...new Set((data.rankSlugs || []).map((s) => String(s).trim()).filter(Boolean))];
  const optionRows = toOptionRows(data.options);

  const poll = await prisma.meetingPolls.create({
    data: {
      title: data.title.trim(),
      description: data.description ? String(data.description).trim() : null,
      timezone: data.timezone || "UTC",
      audienceMode: AUDIENCE_MODE.RANKS,
      status: POLL_STATUS.OPEN,
      deadlineAt: data.deadlineAt ? new Date(data.deadlineAt) : null,
      createdByUserId: actorId,
      options: { create: optionRows },
      roles: { create: rankSlugs.map((rankSlug) => ({ rankSlug })) },
    },
    include: { options: { orderBy: { orderIndex: "asc" } }, roles: true },
  });

  const roster = await refreshRoster(poll.pollId, rankSlugs);

  return { ...poll, ...roster };
}

/**
 * Update a poll's details.  Options are replaced wholesale only when `options`
 * is supplied; see replaceOptions() for why that is destructive.
 */
export async function updatePoll(pollId, data, _actorId) {
  const id = parseInt(pollId);
  const existing = await prisma.meetingPolls.findUnique({
    where: { pollId: id },
    include: { options: true },
  });
  if (!existing) throw new Error("Meeting poll not found.");
  if (existing.status !== POLL_STATUS.OPEN) {
    throw new Error(`Cannot edit a poll that is ${existing.status}.`);
  }

  // Validate against the merged shape so a title-only edit is not rejected for
  // omitting options.
  assertValid({
    title: data.title !== undefined ? data.title : existing.title,
    description: data.description !== undefined ? data.description : existing.description,
    timezone: data.timezone !== undefined ? data.timezone : existing.timezone,
    deadlineAt: data.deadlineAt !== undefined ? data.deadlineAt : existing.deadlineAt,
    audienceMode: data.audienceMode !== undefined ? data.audienceMode : existing.audienceMode,
    options: Array.isArray(data.options) ? data.options : existing.options,
  });

  const updateData = {};
  if (data.title !== undefined) updateData.title = data.title.trim();
  if (data.description !== undefined) {
    updateData.description = data.description ? String(data.description).trim() : null;
  }
  if (data.timezone !== undefined) updateData.timezone = data.timezone || "UTC";
  if (data.deadlineAt !== undefined) {
    updateData.deadlineAt = data.deadlineAt ? new Date(data.deadlineAt) : null;
  }

  await prisma.meetingPolls.update({ where: { pollId: id }, data: updateData });

  if (Array.isArray(data.options)) {
    await replaceOptions(id, data.options);
  }

  if (Array.isArray(data.rankSlugs)) {
    const rankSlugs = [...new Set(data.rankSlugs.map((s) => String(s).trim()).filter(Boolean))];
    await prisma.meetingPollRoles.deleteMany({ where: { pollId: id } });
    if (rankSlugs.length > 0) {
      await prisma.meetingPollRoles.createMany({
        data: rankSlugs.map((rankSlug) => ({ pollId: id, rankSlug })),
      });
    }
    await refreshRoster(id, rankSlugs);
  }

  return getPollById(id);
}

/**
 * Replace a poll's options.
 *
 * Destructive by design: responses cascade-delete with the option they were
 * made against, because an answer to "Tuesday 7pm" is meaningless once that
 * slot is edited into something else.  Options whose start/end/label are
 * unchanged are matched by optionId and left alone, so re-ordering or adding a
 * slot does not discard existing answers.
 */
export async function replaceOptions(pollId, options) {
  const id = parseInt(pollId);
  const incoming = toOptionRows(options);
  const existing = await prisma.meetingPollOptions.findMany({ where: { pollId: id } });

  const keptIds = [];

  for (const [index, option] of incoming.entries()) {
    const suppliedId = options[index]?.optionId ? parseInt(options[index].optionId) : null;
    const match = suppliedId ? existing.find((e) => e.optionId === suppliedId) : null;

    if (match) {
      await prisma.meetingPollOptions.update({
        where: { optionId: match.optionId },
        data: option,
      });
      keptIds.push(match.optionId);
    } else {
      const created = await prisma.meetingPollOptions.create({
        data: { ...option, pollId: id },
      });
      keptIds.push(created.optionId);
    }
  }

  const removedIds = existing.filter((e) => !keptIds.includes(e.optionId)).map((e) => e.optionId);
  if (removedIds.length > 0) {
    await prisma.meetingPollOptions.deleteMany({ where: { optionId: { in: removedIds } } });
  }

  return prisma.meetingPollOptions.findMany({
    where: { pollId: id },
    orderBy: { orderIndex: "asc" },
  });
}

/**
 * Re-expand the roster from the given ranks.
 *
 * Existing invitees are updated in place rather than deleted and recreated, so
 * responses and `notifiedAt` survive.  Someone who has fallen out of every rank
 * is soft-removed (`removedAt`) rather than deleted, so their answers are kept
 * if they are added back.  Manually added invitees are never touched.
 *
 * This is the seam the later send-time re-resolution pass will call.
 */
export async function refreshRoster(pollId, rankSlugs = null) {
  const id = parseInt(pollId);

  const slugs = rankSlugs
    ? rankSlugs
    : (await prisma.meetingPollRoles.findMany({ where: { pollId: id } })).map((r) => r.rankSlug);

  const { invitees, unresolved } = await expandRanksToInvitees(slugs);

  const existing = await prisma.meetingPollInvitees.findMany({ where: { pollId: id } });
  const existingByUserId = new Map(existing.map((invitee) => [invitee.userId, invitee]));
  const resolvedUserIds = new Set(invitees.map((invitee) => invitee.userId));

  for (const invitee of invitees) {
    const current = existingByUserId.get(invitee.userId);

    if (current) {
      await prisma.meetingPollInvitees.update({
        where: { inviteeId: current.inviteeId },
        data: {
          canRespond: invitee.canRespond,
          // A manual add stays manual even if the person also holds the rank.
          viaRankSlug: current.source === "manual" ? current.viaRankSlug : invitee.viaRankSlug,
          removedAt: null,
        },
      });
    } else {
      await prisma.meetingPollInvitees.create({
        data: {
          pollId: id,
          userId: invitee.userId,
          source: "role",
          viaRankSlug: invitee.viaRankSlug,
          canRespond: invitee.canRespond,
        },
      });
    }
  }

  // Soft-remove role-sourced invitees who no longer hold any selected rank.
  const staleIds = existing
    .filter(
      (invitee) =>
        invitee.source === "role" && !resolvedUserIds.has(invitee.userId) && !invitee.removedAt
    )
    .map((invitee) => invitee.inviteeId);

  if (staleIds.length > 0) {
    await prisma.meetingPollInvitees.updateMany({
      where: { inviteeId: { in: staleIds } },
      data: { removedAt: new Date() },
    });
  }

  return { rosterSize: invitees.length, unresolved };
}

/** Add someone to the roster by hand, outside the rank expansion. */
export async function addManualInvitee(pollId, userId) {
  const id = parseInt(pollId);
  const uid = parseInt(userId);

  const user = await prisma.users.findUnique({ where: { userId: uid } });
  if (!user) throw new Error("User not found.");

  const canRespond = !user.is_placeholder && !user.account_disabled && Boolean(user.password_hash);

  return prisma.meetingPollInvitees.upsert({
    where: { pollId_userId: { pollId: id, userId: uid } },
    create: { pollId: id, userId: uid, source: "manual", canRespond },
    update: { source: "manual", canRespond, removedAt: null },
  });
}

/** Soft-remove an invitee, keeping any answers they already gave. */
export async function removeInvitee(pollId, userId) {
  return prisma.meetingPollInvitees.updateMany({
    where: { pollId: parseInt(pollId), userId: parseInt(userId) },
    data: { removedAt: new Date() },
  });
}

/**
 * Record one invitee's availability across the whole poll.
 *
 * All-or-nothing: a submission must cover every option with yes/no/maybe.  A
 * partial grid would silently read as "no opinion" on the slots it omitted,
 * which is indistinguishable from an unanswered poll when ranking — so it is
 * rejected here, at the service layer, rather than only being prevented by the
 * UI.  The write is wrapped in a transaction so a rejected or failed submission
 * never leaves half a grid behind.
 *
 * @param {number} pollId
 * @param {number} userId
 * @param {{optionId: number, availability: string}[]} answers
 */
export async function recordResponses(pollId, userId, answers) {
  const id = parseInt(pollId);
  const uid = parseInt(userId);

  const poll = await prisma.meetingPolls.findUnique({
    where: { pollId: id },
    include: { options: true },
  });
  if (!poll) throw new Error("Meeting poll not found.");
  if (poll.status !== POLL_STATUS.OPEN) {
    throw new Error(`This meeting poll is ${poll.status} and no longer accepting responses.`);
  }
  if (isPastDeadline(poll)) {
    throw new Error("The response deadline for this meeting poll has passed.");
  }

  const invitee = await prisma.meetingPollInvitees.findFirst({
    where: { pollId: id, userId: uid, removedAt: null },
  });
  if (!invitee) throw new Error("You are not invited to this meeting poll.");
  if (!invitee.canRespond) throw new Error("Your account cannot respond to meeting polls.");

  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error("A response is required for every time option.");
  }

  const validAvailability = new Set(Object.values(AVAILABILITY));
  const byOptionId = new Map();

  for (const answer of answers) {
    const optionId = parseInt(answer?.optionId);
    if (!Number.isInteger(optionId)) {
      throw new Error("Invalid time option in response.");
    }
    if (!validAvailability.has(answer?.availability)) {
      throw new Error("Availability must be one of: yes, no, maybe.");
    }
    if (byOptionId.has(optionId)) {
      throw new Error("Duplicate response for the same time option.");
    }
    byOptionId.set(optionId, answer.availability);
  }

  const pollOptionIds = poll.options.map((option) => option.optionId);

  const unknown = [...byOptionId.keys()].filter((optionId) => !pollOptionIds.includes(optionId));
  if (unknown.length > 0) {
    throw new Error("Response refers to a time option that is not on this poll.");
  }

  const missing = pollOptionIds.filter((optionId) => !byOptionId.has(optionId));
  if (missing.length > 0) {
    throw new Error(
      `A response is required for every time option — ${missing.length} of ${pollOptionIds.length} are missing.`
    );
  }

  await prisma.$transaction([
    prisma.meetingPollResponses.deleteMany({ where: { pollId: id, userId: uid } }),
    prisma.meetingPollResponses.createMany({
      data: pollOptionIds.map((optionId) => ({
        pollId: id,
        userId: uid,
        optionId,
        availability: byOptionId.get(optionId),
      })),
    }),
  ]);

  return getPollById(id, uid);
}

/** Cancel a poll, leaving its answers intact for the record. */
export async function cancelPoll(pollId, _actorId) {
  const id = parseInt(pollId);
  const poll = await prisma.meetingPolls.findUnique({ where: { pollId: id } });
  if (!poll) throw new Error("Meeting poll not found.");
  if (poll.status === POLL_STATUS.CANCELLED) throw new Error("This poll is already cancelled.");

  return prisma.meetingPolls.update({
    where: { pollId: id },
    data: { status: POLL_STATUS.CANCELLED },
  });
}

/**
 * Hard-delete a poll.  Options, roles, invitees and responses cascade.
 *
 * Unlike events this is not a soft delete: a meeting poll is a scheduling
 * scratchpad, and there is no public permalink to keep resolvable.  Cancel is
 * the non-destructive option.
 */
export async function deletePoll(pollId, _actorId) {
  const id = parseInt(pollId);
  const poll = await prisma.meetingPolls.findUnique({ where: { pollId: id } });
  if (!poll) throw new Error("Meeting poll not found.");

  return prisma.meetingPolls.delete({ where: { pollId: id } });
}
