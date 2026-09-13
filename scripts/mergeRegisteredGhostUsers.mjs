/*
 * One-off cleanup: fold a *registered* placeholder ("ghost") user row into the
 * real Minecraft account for the same person.
 *
 * This is the companion to scripts/mergePlaceholderUsers.mjs. That script only
 * touches ghosts with NO credentials (account_registered IS NULL AND
 * password_hash IS NULL). It deliberately skips the harder case this script
 * handles: a ghost that a person later attached a website login to.
 *
 * How it happens (the "Thylakin bug"):
 *   1. Discord user messages a support ticket before linking -> createUnlinkedUser
 *      inserts a ghost row (lowercased Discord name, MySQL UUID() v1 uuid,
 *      discordId set, is_placeholder = 1).
 *   2. They register a website account. Registration promotes the ghost *in
 *      place* only when the ghost's uuid equals their real Mojang uuid
 *      (routes/sessionRoutes.js) -- which it never does for a UUID() ghost --
 *      so the credentials land on the ghost row with its fake uuid.
 *   3. Their real Minecraft account row (real v4 uuid, real playtime, no
 *      password) can now never be linked: username / email / "account already
 *      exists" guards all trip.
 *
 * This script finds those ghosts, moves the auth fields onto the real account
 * (only when the real account has no login of its own -- otherwise it is a
 * genuine two-logins conflict and gets flagged for manual review), then runs
 * mergePlaceholderUser to carry over the Discord link + ticket history and
 * delete the ghost.
 *
 * Ghost signature (same as the sibling script, minus the credential filter):
 *   - discordId is set
 *   - no game sessions (never actually played)
 *   - uuid is not a Mojang v4 UUID (UUID() yields a v1 uuid: version nibble '1')
 *   - is_placeholder = 1 OR the row carries website credentials
 *
 * Real-account match (exactly one required):
 *   - same discordId on a real, played-in / v4-uuid account, OR
 *   - a case-insensitive username match against one
 *
 * Usage:
 *   node scripts/mergeRegisteredGhostUsers.mjs            # apply
 *   node scripts/mergeRegisteredGhostUsers.mjs --dry-run  # report only
 */
import dotenv from "dotenv";
dotenv.config();

import db from "../controllers/databaseController.js";
import { mergePlaceholderUser } from "../controllers/userController.js";

const DRY_RUN = process.argv.includes("--dry-run");

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results || []);
    });
  });
}

// A real account either has a Mojang-style v4 UUID or has actually played.
const REAL_ACCOUNT_PREDICATE = `
  u.is_placeholder = 0
  AND (
    SUBSTRING(REPLACE(u.uuid, '-', ''), 13, 1) = '4'
    OR EXISTS (SELECT 1 FROM gameSessions gs WHERE gs.userId = u.userId)
  )
`;

// Ghost = fake (non-v4) uuid, has a Discord link, never played, and either
// explicitly flagged or carrying a website login it should not own.
async function findRegisteredGhosts() {
  return query(`
    SELECT u.*
      FROM users u
     WHERE u.discordId IS NOT NULL
       AND SUBSTRING(REPLACE(u.uuid, '-', ''), 13, 1) <> '4'
       AND NOT EXISTS (SELECT 1 FROM gameSessions gs WHERE gs.userId = u.userId)
       AND (
         u.is_placeholder = 1
         OR u.password_hash IS NOT NULL
         OR u.account_registered IS NOT NULL
         OR u.email IS NOT NULL
       )
       AND (
         u.password_hash IS NOT NULL
         OR u.account_registered IS NOT NULL
         OR u.email IS NOT NULL
       )
     ORDER BY u.userId ASC
  `);
}

async function findRealMatches(ghost) {
  return query(
    `
    SELECT u.*
      FROM users u
     WHERE u.userId <> ?
       AND ${REAL_ACCOUNT_PREDICATE}
       AND (
         u.discordId = ?
         OR LOWER(u.username) = LOWER(?)
       )
  `,
    [ghost.userId, ghost.discordId, ghost.username]
  );
}

// Move the website login from the ghost onto the survivor, then merge.
// Wrapped in a single transaction: the ghost's email must be released before
// it can be written onto the survivor (users.email is UNIQUE), so a failure
// mid-way must not leave the ghost stripped and the survivor un-updated.
async function moveCredentialsAndMerge(ghost, survivor) {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Release UNIQUE-constrained / login columns on the ghost first.
    await conn.query(
      `UPDATE users
          SET email = NULL, password_hash = NULL, email_verified = 0,
              email_verified_at = NULL, account_registered = NULL
        WHERE userId = ?`,
      [ghost.userId]
    );

    // Write them onto the survivor. The survivor is guaranteed to have no
    // login of its own here (hasOwnLogin gate in the caller), so these are
    // straight assignments rather than COALESCE merges; account_registered is
    // still guarded in case a code path set it without a password.
    await conn.query(
      `UPDATE users
          SET email = ?,
              password_hash = ?,
              email_verified = ?,
              email_verified_at = ?,
              account_registered = COALESCE(account_registered, ?)
        WHERE userId = ?`,
      [
        ghost.email,
        ghost.password_hash,
        ghost.email_verified ? 1 : 0,
        ghost.email_verified_at,
        ghost.account_registered ?? new Date(),
        survivor.userId,
      ]
    );

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  // Carries discordId (survivor keeps its own if set), repoints ticket /
  // notification FKs, clears userVerifyLink, deletes the ghost row.
  return mergePlaceholderUser(ghost.userId, survivor.userId);
}

function hasOwnLogin(row) {
  return Boolean(row.password_hash || row.email);
}

async function main() {
  console.log(
    `[merge-registered-ghosts] Starting${
      DRY_RUN ? " (DRY RUN — no changes will be made)" : ""
    }`
  );

  const ghosts = await findRegisteredGhosts();
  console.log(
    `[merge-registered-ghosts] Found ${ghosts.length} registered placeholder row(s)`
  );

  let merged = 0;
  let skippedNoMatch = 0;
  let skippedAmbiguous = 0;
  let skippedConflict = 0;

  for (const ghost of ghosts) {
    const matches = await findRealMatches(ghost);

    if (matches.length === 0) {
      skippedNoMatch += 1;
      console.log(
        `[merge-registered-ghosts] SKIP ghost userId=${ghost.userId} username="${ghost.username}" discordId=${ghost.discordId}: no real account found`
      );
      continue;
    }

    if (matches.length > 1) {
      skippedAmbiguous += 1;
      console.warn(
        `[merge-registered-ghosts] MANUAL REVIEW ghost userId=${ghost.userId} username="${ghost.username}" discordId=${ghost.discordId}: ${matches.length} possible real accounts -> [${matches
          .map((m) => `${m.userId}:${m.username}`)
          .join(", ")}]`
      );
      continue;
    }

    const survivor = matches[0];

    if (hasOwnLogin(survivor)) {
      skippedConflict += 1;
      console.warn(
        `[merge-registered-ghosts] MANUAL REVIEW ghost userId=${ghost.userId} ("${ghost.username}", email=${ghost.email}) -> real userId=${survivor.userId} ("${survivor.username}", email=${survivor.email}): the real account already has its own login. Two distinct logins — decide which email/password survives, then re-run or merge by hand.`
      );
      continue;
    }

    console.log(
      `[merge-registered-ghosts] MERGE ghost userId=${ghost.userId} ("${ghost.username}", email=${ghost.email}) -> real userId=${survivor.userId} ("${survivor.username}")`
    );

    if (DRY_RUN) {
      merged += 1;
      continue;
    }

    try {
      const summary = await moveCredentialsAndMerge(ghost, survivor);
      merged += 1;
      console.log(`[merge-registered-ghosts]   done`, summary);
    } catch (error) {
      console.error(
        `[merge-registered-ghosts]   FAILED to merge ghost userId=${ghost.userId}:`,
        error
      );
    }
  }

  console.log(
    `[merge-registered-ghosts] Complete. merged=${merged} skippedNoMatch=${skippedNoMatch} skippedAmbiguous=${skippedAmbiguous} skippedConflict=${skippedConflict}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[merge-registered-ghosts] Fatal error:", error);
    process.exit(1);
  });
