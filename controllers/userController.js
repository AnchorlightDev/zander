import { hashEmail } from "../api/common.js";
import db, { luckpermsDb } from "./databaseController.js";
import { sanitizeForumHtml } from "../lib/htmlSanitize.js";

export function UserGetter() {
  this.byUsername = function (username) {
    return new Promise((resolve, reject) => {
      db.query(
        `SELECT * FROM users WHERE username=?;`,
        [username],
        function (error, results, fields) {
          if (error) {
            reject(error);
          }

          if (!results || !results.length) {
            resolve(null); // User not found
          } else {
            resolve(results[0]); // Resolve with user data
          }
        }
      );
    });
  };

  this.byEmail = function (email) {
    return new Promise((resolve, reject) => {
      db.query(
        `SELECT * FROM users WHERE LOWER(email)=LOWER(?);`,
        [email],
        function (error, results) {
          if (error) {
            reject(error);
          }

          if (!results || !results.length) {
            resolve(null);
          } else {
            resolve(results[0]);
          }
        }
      );
    });
  };

  this.byUserId = function (userId) {
    return new Promise((resolve, reject) => {
      db.query(
        `SELECT * FROM users WHERE userId=?;`,
        [userId],
        function (error, results) {
          if (error) {
            reject(error);
          }

          if (!results || !results.length) {
            resolve(null);
          } else {
            resolve(results[0]);
          }
        }
      );
    });
  };

  this.byUsernameOrEmail = async function (identifier) {
    const byUsername = await this.byUsername(identifier);
    if (byUsername) {
      return byUsername;
    }

    return await this.byEmail(identifier);
  };

  this.byUUID = function (uuid) {
    return new Promise((resolve, reject) => {
      db.query(
        `SELECT * FROM users WHERE uuid=?;`,
        [uuid],
        function (error, results, fields) {
          if (error) {
            reject(error);
          }
          if (!results || !results.length) {
            resolve(null); // User not found
          } else {
            resolve(results[0]); // Resolve with user data
          }
        }
      );
    });
  };

  // Find a placeholder ("ghost") row that collides with a registration
  // attempt. Placeholder rows are created by createUnlinkedUser with a
  // lowercased Discord username and a random non-Mojang UUID, so the
  // realistic collision is a case-insensitive username match; a UUID
  // match is also honoured for completeness.
  this.placeholderMatch = function (username, uuid = null) {
    return new Promise((resolve, reject) => {
      db.query(
        `SELECT * FROM users
          WHERE is_placeholder = 1
            AND (LOWER(username) = LOWER(?) OR (? IS NOT NULL AND uuid = ?))
          LIMIT 1;`,
        [username, uuid, uuid],
        function (error, results) {
          if (error) {
            reject(error);
            return;
          }

          resolve(results && results.length ? results[0] : null);
        }
      );
    });
  };

  this.byDiscordId = function (discordId) {
    return new Promise((resolve, reject) => {
      db.query(
        `SELECT * FROM users WHERE discordId=?;`,
        [discordId],
        function (error, results, fields) {
          if (error) {
            reject(error);
          }

          if (!results || !results.length) {
            resolve(null); // User not found
          } else {
            resolve(results[0]); // Resolve with user data
          }
        }
      );
    });
  };

  this.hasJoined = async function (username, uuid = null) {
    const trimmedUsername = username ? username.trim() : null;
    const trimmedUuid = uuid ? uuid.trim() : null;

    const runQuery = (sql, params) =>
      new Promise((resolve, reject) => {
        db.query(sql, params, (error, results) => {
          if (error) {
            return reject(error);
          }

          resolve(results || []);
        });
      });

    if (trimmedUsername) {
      const usernameMatch = await runQuery(
        `SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1`,
        [trimmedUsername]
      );

      if (usernameMatch.length) {
        return true;
      }
    }

    if (trimmedUuid) {
      const uuidMatch = await runQuery(
        `SELECT 1 FROM users WHERE uuid = ? LIMIT 1`,
        [trimmedUuid]
      );

      if (uuidMatch.length) {
        return true;
      }
    }

    if (!trimmedUsername) {
      return false;
    }

    const luckPermsParams = [trimmedUsername];
    let luckPermsQuery =
      `SELECT 1 FROM luckperms_players WHERE LOWER(username) = LOWER(?) LIMIT 1`;

    if (trimmedUuid) {
      // LuckPerms MySQL stores uuid as VARCHAR(36) with dashes — compare
      // directly, no UNHEX() (which would produce binary that never matches).
      luckPermsQuery =
        `SELECT 1 FROM luckperms_players WHERE LOWER(username) = LOWER(?) OR LOWER(uuid) = LOWER(?) LIMIT 1`;
      luckPermsParams.push(trimmedUuid);
    }

    const luckPermsMatch = await new Promise((resolve, reject) => {
      luckpermsDb.query(luckPermsQuery, luckPermsParams, (error, results) => {
        if (error) return reject(error);
        resolve(results || []);
      });
    });

    return luckPermsMatch.length > 0;
  };

  this.getBedrockUuid = async function (username) {
    const trimmedUsername = username ? username.trim() : null;
    if (!trimmedUsername) return null;

    const runQuery = (sql, params) =>
      new Promise((resolve, reject) => {
        db.query(sql, params, (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        });
      });

    // Check users table first
    const userRows = await runQuery(
      `SELECT uuid FROM users WHERE LOWER(username) = LOWER(?) AND uuid IS NOT NULL LIMIT 1`,
      [trimmedUsername]
    );
    if (userRows.length && userRows[0].uuid) {
      return userRows[0].uuid;
    }

    // Check luckperms_players table. LuckPerms MySQL stores uuid as
    // VARCHAR(36) with dashes already — select it as-is, no HEX() needed.
    const luckPermsRows = await new Promise((resolve, reject) => {
      luckpermsDb.query(
        `SELECT LOWER(uuid) AS uuid FROM luckperms_players WHERE LOWER(username) = LOWER(?) LIMIT 1`,
        [trimmedUsername],
        (error, results) => {
          if (error) return reject(error);
          resolve(results || []);
        }
      );
    });
    if (luckPermsRows.length && luckPermsRows[0].uuid) {
      return luckPermsRows[0].uuid;
    }

    return null;
  };

  this.isRegistered = function (discordId) {
    return new Promise((resolve, reject) => {
      // Execute a SQL query to check if the user exists in the database
      db.query(
        `SELECT * FROM users WHERE discordId=?;`,
        [discordId],
        function (error, results, fields) {
          if (error) {
            // If there's an error with the database query, reject the Promise
            reject(error);
          }

          // Check if the query returned any results
          if (!results || !results.length) {
            // If no results were found, resolve with false (user not registered)
            resolve(false);
          } else {
            // If results were found, resolve with true (user is registered)
            resolve(true);
          }
        }
      );
    });
  };
}

export function UserLinkGetter() {
  this.getUserByCode = function (code) {
    return new Promise((resolve, reject) => {
      db.query(
        `SELECT u.*, uv.verifyId FROM users u JOIN userVerifyLink uv ON u.uuid = uv.uuid WHERE uv.linkCode = ? AND uv.codeExpiry > NOW();`,
        [code],
        function (error, results, fields) {
          if (error) {
            reject(error);
          }

          if (!results || !results.length) {
            resolve(null); // User not found
          } else {
            resolve(results[0]); // Resolve with user data
          }
        }
      );
    });
  };

  this.link = function (uuid, discordId) {
    return new Promise((resolve, reject) => {
      db.query(
        `UPDATE users SET discordId=?, account_registered=? WHERE uuid=?`,
        [discordId, new Date(), uuid],
        function (error, results, fields) {
          if (error) {
            reject(error);
          }

          db.query(
            `DELETE FROM userVerifyLink WHERE uuid=?`,
            [uuid],
            function (deleteError) {
              if (deleteError) {
                return reject(deleteError);
              }

              resolve(true);
            }
          );
        }
      );
    });
  };

  this.markWebsiteRegistrationComplete = function (uuid) {
    return new Promise((resolve, reject) => {
      db.query(
        `UPDATE users SET account_registered=? WHERE uuid=?`,
        [new Date(), uuid],
        function (error) {
          if (error) {
            return reject(error);
          }

          db.query(
            `DELETE FROM userVerifyLink WHERE uuid=?`,
            [uuid],
            function (deleteError) {
              if (deleteError) {
                return reject(deleteError);
              }

              resolve(true);
            }
          );
        }
      );
    });
  };
}

export function createLocalUser({ uuid, username, email, passwordHash }) {
  return new Promise((resolve, reject) => {
    db.query(
      `INSERT INTO users (uuid, username, email, password_hash) VALUES (?, ?, ?, ?)`,
      [uuid, username, email, passwordHash],
      function (error, results) {
        if (error) {
          return reject(error);
        }

        resolve({ userId: results.insertId });
      }
    );
  });
}

export function updateLocalUserCredentials(
  userId,
  { email, passwordHash, username }
) {
  return new Promise((resolve, reject) => {
    const updates = [];
    const params = [];

    if (typeof email !== "undefined") {
      updates.push(`email = ?`);
      params.push(email);
    }

    if (typeof passwordHash !== "undefined") {
      updates.push(`password_hash = ?`);
      params.push(passwordHash);
    }

    if (typeof username !== "undefined") {
      updates.push(`username = ?`);
      params.push(username);
    }

    updates.push(`email_verified = 0`);
    updates.push(`email_verified_at = NULL`);

    params.push(userId);

    db.query(
      `UPDATE users SET ${updates.join(", ")} WHERE userId = ?`,
      params,
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve(true);
      }
    );
  });
}

export function markEmailVerified(userId) {
  return new Promise((resolve, reject) => {
    db.query(
      `UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE userId = ?`,
      [userId],
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve(true);
      }
    );
  });
}

export function clearPlaceholderFlag(userId) {
  return new Promise((resolve, reject) => {
    db.query(
      `UPDATE users SET is_placeholder = 0 WHERE userId = ?`,
      [userId],
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve(true);
      }
    );
  });
}

export function markAccountRegistered(userId) {
  return new Promise((resolve, reject) => {
    db.query(
      `UPDATE users SET account_registered = NOW() WHERE userId = ?`,
      [userId],
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve(true);
      }
    );
  });
}

export async function getProfilePicture(username) {
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT * FROM users WHERE username=?;`,
      [username],
      async function (error, results, fields) {
        if (error) {
          reject(error);
        }

        let profilePictureType = results[0].profilePicture_type;

        if (profilePictureType == "CRAFTATAR") {
          let craftUUID = results[0].uuid;
          return resolve(`https://crafthead.net/helm/${craftUUID}`);
        }

        if (profilePictureType == "GRAVATAR") {
          let email = results[0].profilePicture_email;
          let emailHash = await hashEmail(email); // Await here
          return resolve(`https://gravatar.com/avatar/${emailHash}?size=300`);
        }
      }
    );
  });
}

export async function setProfileDisplayPreferences(
  userId,
  profilePicture_type,
  profilePicture_email
) {
  db.query(
    `UPDATE users SET profilePicture_type=?, profilePicture_email=? WHERE userId=?;`,
    [profilePicture_type, profilePicture_email, userId],
    function (error, results, fields) {
      if (error) {
        console.error("Failed to update profile display preferences", error);
      }
    }
  );
}

export async function setProfileUserInterests(
  userId,
  social_interests
) {
  db.query(
    `UPDATE users SET social_interests=? WHERE userId=?;`,
    [social_interests, userId],
    function (error, results, fields) {
      if (error) {
        console.error("Failed to update profile interests", error);
      }
    }
  );
}

export async function setProfileSocialConnections(
  userId,
  social_discord,
  social_steam,
  social_twitter_x,
  social_instagram,
  social_reddit,
  social_spotify
) {
  db.query(
    `UPDATE users SET social_discord=?, social_steam=?, social_twitter_x=?, social_instagram=?, social_reddit=?, social_spotify=? WHERE userId=?;`,
    [
      social_discord,
      social_steam,
      social_twitter_x,
      social_instagram,
      social_reddit,
      social_spotify,
      userId,
    ],
    function (error, results, fields) {
      if (error) {
        console.error("Failed to update social connections", error);
      }
    }
  );
}

export async function setProfileUserAboutMe(
  userId,
  social_aboutMe
) {
  social_aboutMe = sanitizeForumHtml(social_aboutMe);
  db.query(
    `UPDATE users SET social_aboutMe=? WHERE userId=?;`,
    [social_aboutMe, userId],
    function (error, results, fields) {
      if (error) {
        console.error("Failed to update profile bio", error);
      }
    }
  );
}

export function updateUserPassword(userId, passwordHash) {
  return new Promise((resolve, reject) => {
    db.query(
      `UPDATE users SET password_hash = ? WHERE userId = ?`,
      [passwordHash, userId],
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve(true);
      }
    );
  });
}

const LUCKPERMS_USER_PERMISSIONS_TABLE = "luckperms_user_permissions";
const LUCKPERMS_GROUP_PERMISSIONS_TABLE = "luckperms_group_permissions";
const LUCKPERMS_PLAYERS_TABLE = "luckperms_players";

function normaliseUuid(uuid) {
  if (!uuid) return null;

  const trimmed = String(uuid).trim();
  if (!trimmed) return null;

  return trimmed.replace(/-/g, "").toLowerCase();
}

function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.query(query, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

function runLuckPermsQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(query, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

export async function getUserPermissions(userData = {}) {
  const permissionSet = new Set();
  const directRankOrder = [];
  const seenDirectRanks = new Set();
  const queuedRanks = [];
  const queuedRankSet = new Set();

  const userId = userData?.userId || null;
  // rawUuid is the LP-native UUID string (VARCHAR with dashes, e.g. "550e8400-e29b-41d4-a716-446655440000").
  // LuckPerms MySQL stores uuid as VARCHAR(36) with dashes, so LP queries must use this value
  // directly rather than UNHEX(hex-without-dashes), which would produce binary that never matches.
  let rawUuid = userData?.uuid || null;
  const username = userData?.username || null;

  // uuidHex is kept only as a non-null sentinel for the "do we have a UUID?" guards below.
  let uuidHex = normaliseUuid(rawUuid);

  const ensureUuid = async () => {
    if (uuidHex) {
      return;
    }

    if (userId) {
      const rows = await runQuery(
        `SELECT uuid FROM users WHERE userId = ? LIMIT 1`,
        [userId]
      );

      if (rows.length && rows[0].uuid) {
        rawUuid = rows[0].uuid;
        uuidHex = normaliseUuid(rows[0].uuid);
        return;
      }
    }

    if (username) {
      // LP stores uuid as VARCHAR(36) with dashes — select it as-is, no HEX() conversion.
      const rows = await runLuckPermsQuery(
        `SELECT uuid FROM ${LUCKPERMS_PLAYERS_TABLE} WHERE LOWER(username) = LOWER(?) LIMIT 1`,
        [username]
      );

      if (rows.length && rows[0].uuid) {
        rawUuid = rows[0].uuid;
        uuidHex = normaliseUuid(rows[0].uuid);
      }
    }
  };

  await ensureUuid();

  if (!uuidHex && !userId) {
    const emptyPermissions = [];
    emptyPermissions.userRanks = [];
    return emptyPermissions;
  }

  const pushPermission = (value) => {
    if (!value) return;
    permissionSet.add(value);
  };

  const queueRank = (slug, { direct = false } = {}) => {
    if (!slug) {
      return;
    }

    if (direct && !seenDirectRanks.has(slug)) {
      seenDirectRanks.add(slug);
      directRankOrder.push(slug);
    }

    if (!queuedRankSet.has(slug)) {
      queuedRankSet.add(slug);
      queuedRanks.push(slug);
    }
  };

  if (uuidHex) {
    try {
      const directPermissions = await runLuckPermsQuery(
        `SELECT permission
           FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ?
            AND permission NOT LIKE 'group.%'
            AND value = 1
            AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
        [rawUuid]
      );

      directPermissions.forEach(({ permission }) => pushPermission(permission));
    } catch (error) {
      console.error("[PERMISSIONS] Failed to fetch direct user permissions:", error);
    }

    try {
      const rankRows = await runLuckPermsQuery(
        `SELECT SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
           FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ?
            AND permission LIKE 'group.%'
            AND value = 1
            AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())
          ORDER BY permission`,
        [rawUuid]
      );

      rankRows.forEach(({ rankSlug }) => queueRank(rankSlug, { direct: true }));
    } catch (error) {
      console.error("[PERMISSIONS] Failed to fetch user group assignments:", error);
    }
  }

  // Note: no further fallback here — ensureUuid() above already tried
  // resolving this user's uuid via the `users` table (and via LuckPerms'
  // own players table by username), which is the only source the old
  // `userRanks` view fallback could ever have matched against anyway (it
  // joined luckperms_user_permissions.uuid = users.uuid). If uuidHex is
  // still unset here, there's genuinely no uuid to resolve ranks from.

  if (!queuedRanks.length && uuidHex) {
    try {
      const primaryGroupRows = await runLuckPermsQuery(
        `SELECT primary_group AS rankSlug
           FROM ${LUCKPERMS_PLAYERS_TABLE}
          WHERE uuid = ?
          LIMIT 1`,
        [rawUuid]
      );

      primaryGroupRows.forEach(({ rankSlug }) => queueRank(rankSlug, { direct: true }));
    } catch (error) {
      console.error("[PERMISSIONS] Failed to fetch primary group:", error);
    }
  }

  while (queuedRanks.length) {
    const currentBatch = queuedRanks.splice(0, queuedRanks.length);
    const placeholders = currentBatch.map(() => "?").join(", ");

    try {
      const groupPermissions = await runLuckPermsQuery(
        `SELECT name, permission
           FROM ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
          WHERE name IN (${placeholders})
            AND value = 1
            AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
        currentBatch
      );

      groupPermissions.forEach(({ name, permission }) => {
        if (!permission) {
          return;
        }

        if (permission.startsWith("group.")) {
          const inherited = permission.substring("group.".length).trim();
          if (inherited && inherited !== name) {
            queueRank(inherited);
          }
          return;
        }

        pushPermission(permission);
      });
    } catch (error) {
      console.error(
        `[PERMISSIONS] Failed to fetch permissions for groups [${currentBatch.join(", ")}]:`,
        error
      );
    }
  }

  // Note: no further fallbacks here. Both the old `userPermissions` view
  // fallback (keyed on users.uuid — the same uuid ensureUuid() already
  // resolved, or failed to, above) and the old `rankPermissions` view
  // fallback (the same luckperms_group_permissions data the while-loop
  // above already fetches directly, minus the expiry filter it correctly
  // applies) were redundant with — and, for the expiry case, actively less
  // correct than — the direct LuckPerms queries already run above. LuckPerms
  // lives on a separate MySQL server from the main app DB, so those views
  // couldn't be joined cross-server reliably anyway.

  const permissions = Array.from(permissionSet);
  permissions.userRanks = directRankOrder;

  return permissions;
}

export async function getUserStats(userId) {
  const playtimeResult = await new Promise((resolve, reject) => {
    db.query(
      `SELECT SUM(TIME_TO_SEC(TIMEDIFF(COALESCE(sessionEnd, NOW()), sessionStart))) AS totalSeconds FROM gameSessions WHERE userId=?`,
      [userId],
      function (err, results) {
        if (err) return reject(err);
        resolve(results);
      }
    );
  });

  const loginsResult = await new Promise((resolve, reject) => {
    db.query(
      `SELECT COUNT(*) AS totalLogins FROM gameSessions WHERE userId = ?`,
      [userId],
      function (err, results) {
        if (err) return reject(err);
        resolve(results);
      }
    );
  });

  return {
    totalPlaytime: convertSecondsToDuration(playtimeResult[0].totalSeconds),
    totalLogins: loginsResult[0].totalLogins,
  };
}

export function convertSecondsToDuration(seconds) {
  const MINUTE = 60;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const MONTH = 30 * DAY;

  const s = Math.max(0, Number(seconds) || 0);

  if (s === 0) return "None yet";
  if (s < MINUTE) return `${s} seconds`;
  if (s < HOUR) return `${Math.floor(s / MINUTE)} minutes`;
  if (s < DAY) return `${Math.floor(s / HOUR)} hours`;
  if (s < MONTH) return `${Math.floor(s / DAY)} days`;
  return `${Math.floor(s / MONTH)} months`;
}

// LuckPerms lives on a separate MySQL server from the main app DB, so this
// can't be read via the (cross-server, unreliable) `rankPermissions` view —
// query luckpermsDb directly.
export async function getRankPermissions(allRanks) {
  if (!Array.isArray(allRanks) || allRanks.length === 0) {
    return [];
  }

  const placeholders = allRanks.map(() => "?").join(", ");
  const results = await runLuckPermsQuery(
    `SELECT DISTINCT permission
       FROM ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
      WHERE name IN (${placeholders})
        AND permission NOT LIKE 'group.%'
        AND value = 1
        AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
    allRanks
  );

  return results.map((row) => row.permission).filter(Boolean);
}

export async function getUserRanks(userData, userRanks = null) {
  const resolveLuckPermsUuid = async (input) => {
    if (typeof input === "string") {
      const username = input.trim();
      if (!username) return null;

      const localUsers = await runQuery(
        `SELECT uuid FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1`,
        [username]
      );
      if (localUsers.length && localUsers[0].uuid) {
        return localUsers[0].uuid;
      }

      const lpUsers = await runLuckPermsQuery(
        `SELECT uuid FROM ${LUCKPERMS_PLAYERS_TABLE} WHERE LOWER(username) = LOWER(?) LIMIT 1`,
        [username]
      );
      return lpUsers[0]?.uuid || null;
    }

    if (input?.uuid) {
      return input.uuid;
    }

    if (input?.userId) {
      const users = await runQuery(
        `SELECT uuid FROM users WHERE userId = ? LIMIT 1`,
        [input.userId]
      );
      return users[0]?.uuid || null;
    }

    if (input?.username) {
      return resolveLuckPermsUuid(input.username);
    }

    return null;
  };

  // Call with just userData only get directly assigned ranks.
  if (userRanks === null) {
    const rawUuid = await resolveLuckPermsUuid(userData);
    if (!rawUuid) {
      return [];
    }

    const [groupRows, titleRows] = await Promise.all([
      runLuckPermsQuery(
        `SELECT SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
           FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ?
            AND permission LIKE 'group.%'
            AND value = 1
            AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())
          ORDER BY permission`,
        [rawUuid]
      ),
      runLuckPermsQuery(
        `SELECT permission
           FROM ${LUCKPERMS_USER_PERMISSIONS_TABLE}
          WHERE uuid = ?
            AND permission LIKE 'meta.group.%.title.%'
            AND value = 1
            AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
        [rawUuid]
      ),
    ]);

    const titleByRankSlug = {};
    for (const { permission } of titleRows) {
      const [rankSlug, title] = String(permission || "")
        .replace(/^meta\.group\./, "")
        .split(/\.title\./);

      if (rankSlug && title) {
        titleByRankSlug[rankSlug] = title;
      }
    }

    return groupRows.map((row) => ({
      rankSlug: row.rankSlug,
      title: titleByRankSlug[row.rankSlug] || null,
    }));
  }

  if (!Array.isArray(userRanks) || userRanks.length === 0) {
    return [];
  }

  const seen = new Set(userRanks.filter(Boolean));
  const queue = [...seen];

  while (queue.length) {
    const batch = queue.splice(0, queue.length);
    const placeholders = batch.map(() => "?").join(", ");
    const childRows = await runLuckPermsQuery(
      `SELECT SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
         FROM ${LUCKPERMS_GROUP_PERMISSIONS_TABLE}
        WHERE name IN (${placeholders})
          AND permission LIKE 'group.%'
          AND value = 1
          AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())`,
      batch
    );

    for (const { rankSlug } of childRows) {
      if (rankSlug && !seen.has(rankSlug)) {
        seen.add(rankSlug);
        queue.push(rankSlug);
      }
    }
  }

  return [...seen];
}

export async function checkPermissions(username, permissionNode) {
  try {
    const userPermissions = await getUserPermissions(username);
    const hasPermission = userPermissions.includes(permissionNode);

    return hasPermission;
  } catch (error) {
    console.error("Error:", error);
    return false;
  }
}

export async function getUserLastSession(userId) {
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT * FROM gameSessions WHERE userId=? ORDER BY sessionStart DESC LIMIT 1;`,
      [userId],
      async function (err, results) {
        if (err) {
          return reject(err);
        }

        if (results.length === 0) {
          // Return a default value if no session is found
          const defaultSessionData = {
            sessionStart: null,
            sessionEnd: null,
            server: null,
            lastOnlineDiff: null,
            isOnline: false,
          };
          return resolve(defaultSessionData);
        }

        const sessionRecord = results[0];
        const now = new Date();
        let isOnline = !sessionRecord.sessionEnd;

        // Treat stale sessions without an end time as offline after a grace period
        if (isOnline && sessionRecord.sessionStart) {
          const sessionStartDate = new Date(sessionRecord.sessionStart);
          const activeSeconds = Math.floor((now - sessionStartDate) / 1000);
          const staleThresholdSeconds = 24 * 60 * 60; // 24 hours
          if (activeSeconds > staleThresholdSeconds) {
            isOnline = false;
          }
        }

        const lastActivityDate = sessionRecord.sessionEnd
          ? new Date(sessionRecord.sessionEnd)
          : sessionRecord.sessionStart
          ? new Date(sessionRecord.sessionStart)
          : null;

        const sessionDiff = lastActivityDate
          ? convertSecondsToDuration(
              Math.max(0, Math.floor((now - lastActivityDate) / 1000))
            )
          : null;

        const sessionData = {
          sessionStart: sessionRecord.sessionStart,
          sessionEnd: sessionRecord.sessionEnd,
          server: sessionRecord.server,
          lastOnlineDiff: sessionDiff,
          isOnline,
        };

        resolve(sessionData);
      }
    );
  });
}

export async function linkDiscordAccount(userId, discordId, discordHandle = null) {
  return new Promise((resolve, reject) => {
    db.query(
      `UPDATE users SET discordId=?, social_discord=? WHERE userId=?`,
      [discordId, discordHandle, userId],
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve(true);
      }
    );
  });
}

// Repoint the rows that reference a soon-to-be-deleted user row onto the
// surviving row. supportTickets.userId / supportTicketMessages.userId are
// ON DELETE CASCADE, so this MUST run before the placeholder row is deleted
// or the ticket that triggered the ghost account gets destroyed with it.
// supportTicketParticipants has a UNIQUE(ticketId, userId), hence UPDATE IGNORE
// plus a follow-up delete of any rows that could not be moved.
async function repointUserReferences(fromUserId, toUserId) {
  await runQuery(`UPDATE supportTickets SET userId = ? WHERE userId = ?`, [toUserId, fromUserId]);
  await runQuery(`UPDATE supportTicketMessages SET userId = ? WHERE userId = ?`, [toUserId, fromUserId]);
  await runQuery(`UPDATE userNotifications SET userId = ? WHERE userId = ?`, [toUserId, fromUserId]);
  await runQuery(
    `UPDATE IGNORE supportTicketParticipants SET userId = ? WHERE userId = ?`,
    [toUserId, fromUserId]
  );
  await runQuery(`DELETE FROM supportTicketParticipants WHERE userId = ?`, [fromUserId]);
}

/*
    Merge a placeholder ("ghost") user row into a real account row.

    A placeholder row is created by createUnlinkedUser when a Discord user
    opens a support ticket before linking a Minecraft account. When that
    person later registers with their real Minecraft username we want to
    keep the real account and fold the placeholder's Discord link and
    ticket history into it rather than blocking registration.

    - Transfers discordId from the placeholder onto the surviving row when
      the surviving row does not already have one.
    - Repoints ticket / notification foreign keys onto the surviving row.
    - Drops the placeholder's pending verify-link rows (keyed by uuid).
    - Deletes the placeholder row.

    Returns a summary object describing what was moved (for logging).
*/
export async function mergePlaceholderUser(placeholderUserId, survivingUserId) {
  if (!placeholderUserId || !survivingUserId || placeholderUserId === survivingUserId) {
    throw new Error("mergePlaceholderUser requires two distinct user ids");
  }

  const [placeholder] = await runQuery(`SELECT * FROM users WHERE userId = ? LIMIT 1`, [
    placeholderUserId,
  ]);
  const [surviving] = await runQuery(`SELECT * FROM users WHERE userId = ? LIMIT 1`, [
    survivingUserId,
  ]);

  if (!placeholder) throw new Error(`Placeholder user ${placeholderUserId} not found`);
  if (!surviving) throw new Error(`Surviving user ${survivingUserId} not found`);

  const summary = {
    placeholderUserId,
    survivingUserId,
    discordIdTransferred: false,
  };

  if (placeholder.discordId && !surviving.discordId) {
    await runQuery(`UPDATE users SET discordId = ? WHERE userId = ?`, [
      placeholder.discordId,
      survivingUserId,
    ]);
    summary.discordIdTransferred = true;
  }

  // Clear the placeholder's discordId first so the users.discordId lookups
  // (and any unique expectations callers have) never see it on two rows.
  await runQuery(`UPDATE users SET discordId = NULL WHERE userId = ?`, [placeholderUserId]);

  await repointUserReferences(placeholderUserId, survivingUserId);

  if (placeholder.uuid) {
    await runQuery(`DELETE FROM userVerifyLink WHERE uuid = ?`, [placeholder.uuid]);
  }

  await runQuery(`DELETE FROM users WHERE userId = ?`, [placeholderUserId]);

  return summary;
}

export async function unlinkDiscordAccount(userId) {
  return new Promise((resolve, reject) => {
    db.query(
      `UPDATE users SET discordId=NULL, social_discord=NULL WHERE userId=?`,
      [userId],
      function (error) {
        if (error) {
          return reject(error);
        }

        resolve(true);
      }
    );
  });
}
