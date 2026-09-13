import db from "./databaseController.js";

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 20;

export function validatePollInput({ question, options, expiresAt }) {
  const errors = [];

  const q = (question || "").trim();
  if (!q) {
    errors.push("Poll question is required.");
  } else if (q.length > 500) {
    errors.push("Poll question must be 500 characters or fewer.");
  }

  if (!Array.isArray(options) || options.length < POLL_MIN_OPTIONS) {
    errors.push(`At least ${POLL_MIN_OPTIONS} poll options are required.`);
  } else if (options.length > POLL_MAX_OPTIONS) {
    errors.push(`A poll can have at most ${POLL_MAX_OPTIONS} options.`);
  } else {
    const cleaned = options.map((o) => (o || "").trim());
    if (cleaned.some((o) => !o)) {
      errors.push("Poll options cannot be blank.");
    } else if (cleaned.some((o) => o.length > 300)) {
      errors.push("Each poll option must be 300 characters or fewer.");
    }
  }

  if (expiresAt) {
    const expiry = new Date(expiresAt);
    if (isNaN(expiry.getTime())) {
      errors.push("Invalid poll closing date.");
    }
  }

  return errors;
}

export async function createPoll(discussionId, createdByUserId, {
  question,
  options,
  imageUrls = [],
  allowMultiple = false,
  allowVoteChange = false,
  showVoters = false,
  expiresAt = null,
}) {
  const result = await query(
    `INSERT INTO forumPolls
       (discussionId, question, allowMultiple, allowVoteChange, showVoters, expiresAt, createdByUserId)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      discussionId,
      question.trim(),
      allowMultiple ? 1 : 0,
      allowVoteChange ? 1 : 0,
      showVoters ? 1 : 0,
      expiresAt ? new Date(expiresAt) : null,
      createdByUserId,
    ]
  );

  const pollId = result.insertId || result?.[0]?.insertId;

  for (let i = 0; i < options.length; i++) {
    const imageUrl = imageUrls[i] || null;
    await query(
      `INSERT INTO forumPollOptions (pollId, label, imageUrl, orderIndex) VALUES (?, ?, ?, ?)`,
      [pollId, options[i].trim(), imageUrl, i]
    );
  }

  return pollId;
}

export async function getPollByDiscussionId(discussionId, viewerUserId = null) {
  const [pollRow] = await query(
    `SELECT pollId, discussionId, question, allowMultiple, allowVoteChange, showVoters,
            expiresAt, createdByUserId, createdAt, updatedAt
       FROM forumPolls
      WHERE discussionId = ?
      LIMIT 1`,
    [discussionId]
  );

  if (!pollRow) return null;

  const pollId = pollRow.pollId;
  const now = new Date();
  const isOpen = !pollRow.expiresAt || new Date(pollRow.expiresAt) > now;

  const optionRows = await query(
    `SELECT optionId, label, imageUrl, orderIndex
       FROM forumPollOptions
      WHERE pollId = ?
      ORDER BY orderIndex ASC, optionId ASC`,
    [pollId]
  );

  const voteCounts = await query(
    `SELECT optionId, COUNT(*) AS voteCount
       FROM forumPollVotes
      WHERE pollId = ?
      GROUP BY optionId`,
    [pollId]
  );

  const voteCountMap = new Map();
  let totalVotes = 0;
  for (const row of voteCounts) {
    voteCountMap.set(row.optionId, Number(row.voteCount));
    totalVotes += Number(row.voteCount);
  }

  let userVotedOptionIds = [];
  if (viewerUserId) {
    const userVotes = await query(
      `SELECT optionId FROM forumPollVotes WHERE pollId = ? AND userId = ?`,
      [pollId, viewerUserId]
    );
    userVotedOptionIds = userVotes.map((r) => r.optionId);
  }

  // Fetch voter identities only when showVoters is enabled
  const votersByOption = new Map();
  if (pollRow.showVoters) {
    const voterRows = await query(
      `SELECT fpv.optionId, u.userId, u.username, u.uuid,
              u.profilePicture_type, u.profilePicture_email
         FROM forumPollVotes fpv
         JOIN users u ON u.userId = fpv.userId
        WHERE fpv.pollId = ?
        ORDER BY fpv.createdAt ASC`,
      [pollId]
    );

    for (const row of voterRows) {
      if (!votersByOption.has(row.optionId)) {
        votersByOption.set(row.optionId, []);
      }
      let avatarUrl;
      if (row.profilePicture_type === "GRAVATAR" && row.profilePicture_email) {
        avatarUrl = null;
      } else if (row.uuid) {
        avatarUrl = `https://crafthead.net/helm/${row.uuid}`;
      } else {
        avatarUrl = "https://crafthead.net/helm/steve";
      }
      votersByOption.get(row.optionId).push({
        userId: row.userId,
        username: row.username,
        avatarUrl: avatarUrl || `https://crafthead.net/helm/${row.uuid || "steve"}`,
      });
    }
  }

  const options = optionRows.map((row) => {
    const count = voteCountMap.get(row.optionId) || 0;
    return {
      optionId: row.optionId,
      label: row.label,
      imageUrl: row.imageUrl || null,
      orderIndex: row.orderIndex,
      voteCount: count,
      percentage: totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0,
      votedByViewer: userVotedOptionIds.includes(row.optionId),
      voters: votersByOption.get(row.optionId) || [],
    };
  });

  options.sort((a, b) => b.voteCount - a.voteCount || a.orderIndex - b.orderIndex);

  const viewerHasVoted = userVotedOptionIds.length > 0;
  const viewerCanVote = isOpen && viewerUserId !== null && !viewerHasVoted;
  const viewerCanChange =
    isOpen && viewerUserId !== null && viewerHasVoted && !!pollRow.allowVoteChange;

  return {
    pollId,
    discussionId,
    question: pollRow.question,
    allowMultiple: !!pollRow.allowMultiple,
    allowVoteChange: !!pollRow.allowVoteChange,
    showVoters: !!pollRow.showVoters,
    expiresAt: pollRow.expiresAt || null,
    createdByUserId: pollRow.createdByUserId,
    createdAt: pollRow.createdAt,
    isOpen,
    totalVotes,
    options,
    viewerHasVoted,
    viewerVotedOptionIds: userVotedOptionIds,
    viewerCanVote,
    viewerCanChange,
  };
}

async function loadPollRow(pollId) {
  const [row] = await query(
    `SELECT pollId, allowMultiple, allowVoteChange, expiresAt
       FROM forumPolls
      WHERE pollId = ?
      LIMIT 1`,
    [pollId]
  );
  return row || null;
}

async function validateOptionsBelongToPoll(pollId, optionIds) {
  if (!Array.isArray(optionIds) || optionIds.length === 0) {
    throw new Error("No option selected.");
  }
  const placeholders = optionIds.map(() => "?").join(",");
  const valid = await query(
    `SELECT optionId FROM forumPollOptions WHERE pollId = ? AND optionId IN (${placeholders})`,
    [pollId, ...optionIds]
  );
  if (valid.length !== optionIds.length) {
    throw new Error("Invalid poll option.");
  }
}

export async function castVote(pollId, userId, optionIds) {
  const pollRow = await loadPollRow(pollId);
  if (!pollRow) throw new Error("Poll not found.");

  if (pollRow.expiresAt && new Date(pollRow.expiresAt) <= new Date()) {
    throw new Error("This poll has closed.");
  }

  if (!pollRow.allowMultiple && optionIds.length > 1) {
    throw new Error("This poll only allows one choice.");
  }

  await validateOptionsBelongToPoll(pollId, optionIds);

  const existing = await query(
    `SELECT voteId FROM forumPollVotes WHERE pollId = ? AND userId = ? LIMIT 1`,
    [pollId, userId]
  );
  if (existing.length > 0) {
    throw new Error("You have already voted on this poll.");
  }

  for (const optionId of optionIds) {
    await query(
      `INSERT IGNORE INTO forumPollVotes (pollId, optionId, userId) VALUES (?, ?, ?)`,
      [pollId, optionId, userId]
    );
  }
}

export async function changeVote(pollId, userId, optionIds) {
  const pollRow = await loadPollRow(pollId);
  if (!pollRow) throw new Error("Poll not found.");

  if (pollRow.expiresAt && new Date(pollRow.expiresAt) <= new Date()) {
    throw new Error("This poll has closed.");
  }

  if (!pollRow.allowVoteChange) {
    throw new Error("Vote changes are not allowed for this poll.");
  }

  if (!pollRow.allowMultiple && optionIds.length > 1) {
    throw new Error("This poll only allows one choice.");
  }

  await validateOptionsBelongToPoll(pollId, optionIds);

  await query(`DELETE FROM forumPollVotes WHERE pollId = ? AND userId = ?`, [pollId, userId]);

  for (const optionId of optionIds) {
    await query(
      `INSERT IGNORE INTO forumPollVotes (pollId, optionId, userId) VALUES (?, ?, ?)`,
      [pollId, optionId, userId]
    );
  }
}
