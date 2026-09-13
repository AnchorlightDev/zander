/**
 * controllers/usersAdminController.js
 *
 * Data access for the staff "Community -> Users" dashboard. All queries here
 * explicitly allowlist columns and MUST NEVER select password_hash or any
 * token/code/secret column. Uses the raw db.query callback style already used
 * throughout controllers/userController.js and controllers/discordPunishmentController.js.
 *
 * Account-state SQL predicates below must be kept in sync with
 * controllers/userAccountState.js:classifyAccountState.
 */

import db from "./databaseController.js";

const SAFE_LIST_COLUMNS = `
  userId, uuid, username, discordId, email, email_verified, account_registered,
  account_disabled, joined, audit_lastMinecraftLogin, audit_lastWebsiteLogin
`;

const SAFE_DETAIL_COLUMNS = `
  userId, uuid, username, discordId, email, email_verified, email_verified_at,
  account_registered, account_disabled, joined,
  audit_lastMinecraftLogin, audit_lastWebsiteLogin,
  (password_hash IS NOT NULL) AS hasPassword
`;

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

/**
 * Build the shared WHERE predicates + params for both the list and count
 * queries, from dashboard filter/search params.
 */
function buildUserFilters({ search, platform, accountState, emailStatus, discordStatus, disabledStatus } = {}) {
  const clauses = [];
  const params = [];

  const trimmedSearch = search ? String(search).trim() : "";
  if (trimmedSearch) {
    clauses.push(`(username LIKE ? OR uuid = ? OR email LIKE ? OR discordId = ?)`);
    params.push(`%${trimmedSearch}%`, trimmedSearch, `%${trimmedSearch}%`, trimmedSearch);
  }

  if (platform === "JAVA") {
    clauses.push(`username NOT LIKE '.%'`);
  } else if (platform === "BEDROCK") {
    clauses.push(`username LIKE '.%'`);
  }

  // Keep in sync with controllers/userAccountState.js:classifyAccountState
  if (accountState === "REGISTERED") {
    clauses.push(`account_registered IS NOT NULL AND password_hash IS NOT NULL`);
  } else if (accountState === "MINECRAFT_PROFILE_ONLY") {
    clauses.push(`email IS NULL AND password_hash IS NULL AND account_registered IS NULL`);
  } else if (accountState === "REGISTRATION_INCOMPLETE") {
    clauses.push(`
      NOT (account_registered IS NOT NULL AND password_hash IS NOT NULL)
      AND NOT (email IS NULL AND password_hash IS NULL AND account_registered IS NULL)
    `);
  }

  if (emailStatus === "VERIFIED") {
    clauses.push(`email IS NOT NULL AND email_verified = 1`);
  } else if (emailStatus === "UNVERIFIED") {
    clauses.push(`email IS NOT NULL AND email_verified = 0`);
  } else if (emailStatus === "MISSING") {
    clauses.push(`email IS NULL`);
  }

  if (discordStatus === "LINKED") {
    clauses.push(`discordId IS NOT NULL`);
  } else if (discordStatus === "UNLINKED") {
    clauses.push(`discordId IS NULL`);
  }

  if (disabledStatus === "DISABLED") {
    clauses.push(`account_disabled = 1`);
  } else if (disabledStatus === "ACTIVE") {
    clauses.push(`account_disabled = 0`);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { whereSql, params };
}

/**
 * Server-side paginated, searchable, filterable users list.
 * Never returns password_hash or any credential/token column.
 */
export async function getUsersList({
  page = 1,
  limit = 25,
  search,
  platform,
  accountState,
  emailStatus,
  discordStatus,
  disabledStatus,
} = {}) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const offset = (safePage - 1) * safeLimit;

  const { whereSql, params } = buildUserFilters({
    search,
    platform,
    accountState,
    emailStatus,
    discordStatus,
    disabledStatus,
  });

  const [rows, countRows] = await Promise.all([
    runQuery(
      `SELECT ${SAFE_LIST_COLUMNS} FROM users ${whereSql} ORDER BY joined DESC LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    ),
    runQuery(`SELECT COUNT(*) AS total FROM users ${whereSql}`, params),
  ]);

  return {
    rows,
    total: countRows[0]?.total || 0,
    page: safePage,
    limit: safeLimit,
  };
}

/**
 * Efficient aggregate summary stats for the top of the Users page.
 * Computed entirely in SQL, never by iterating rows in JS.
 */
export async function getUsersSummaryStats() {
  const rows = await runQuery(`
    SELECT
      COUNT(*) AS totalPlayers,
      SUM(CASE WHEN account_registered IS NOT NULL AND password_hash IS NOT NULL THEN 1 ELSE 0 END) AS websiteRegistered,
      SUM(CASE WHEN email IS NULL AND password_hash IS NULL AND account_registered IS NULL THEN 1 ELSE 0 END) AS profileOnly,
      SUM(CASE WHEN discordId IS NOT NULL THEN 1 ELSE 0 END) AS discordLinked,
      SUM(CASE WHEN account_disabled = 1 THEN 1 ELSE 0 END) AS disabled
    FROM users
  `);

  const row = rows[0] || {};
  return {
    totalPlayers: row.totalPlayers || 0,
    websiteRegistered: row.websiteRegistered || 0,
    profileOnly: row.profileOnly || 0,
    discordLinked: row.discordLinked || 0,
    disabled: row.disabled || 0,
  };
}

/**
 * Single-user detail lookup with only the safe columns, plus reliably-linked
 * related accounts (same non-null discordId only — no username-similarity
 * matching, per scope).
 */
export async function getUserDetailById(userId) {
  const rows = await runQuery(`SELECT ${SAFE_DETAIL_COLUMNS} FROM users WHERE userId = ?`, [userId]);
  const user = rows[0] || null;
  if (!user) return null;

  let relatedAccounts = [];
  if (user.discordId) {
    relatedAccounts = await runQuery(
      `SELECT ${SAFE_LIST_COLUMNS} FROM users WHERE discordId = ? AND userId != ?`,
      [user.discordId, userId]
    );
  }

  return { ...user, relatedAccounts };
}

/**
 * Reveal the full email for a user. Callers MUST have already checked the
 * zander.web.users.email permission — this function trusts its caller (the
 * same trust model as the existing badges admin API).
 */
export async function getUserEmailById(userId) {
  const rows = await runQuery(`SELECT email FROM users WHERE userId = ?`, [userId]);
  return rows[0]?.email ?? null;
}

/**
 * Change a user's login/recovery email. Deliberately does NOT touch
 * email_verified/email_verified_at — a changed email must go through the
 * normal verification flow, not be auto-marked verified.
 */
export async function updateUserEmail(userId, newEmail) {
  return new Promise((resolve, reject) => {
    db.query(`UPDATE users SET email = ? WHERE userId = ?`, [newEmail, userId], (error) => {
      if (error) return reject(error);
      resolve(true);
    });
  });
}
