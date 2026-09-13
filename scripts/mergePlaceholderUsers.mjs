/*
 * One-off cleanup: merge legacy placeholder ("ghost") user rows into the
 * real Minecraft account for the same person.
 *
 * Placeholder rows were created by createUnlinkedUser (support ticket flow)
 * before the is_placeholder column existed, so this script identifies them
 * by their signature rather than the flag:
 *
 *   - discordId is set
 *   - account_registered IS NULL and password_hash IS NULL
 *   - no game sessions (never logged in)
 *   - UUID is not a Mojang v4 UUID (MySQL UUID() produces a v1 UUID, so the
 *     version nibble is '1' instead of '4')
 *
 * For each ghost it looks for exactly one real account belonging to the same
 * person, matched by:
 *   - the same discordId on a real, played-in account, OR
 *   - a case-insensitive username match against a real, played-in account
 *
 * Exactly one match  -> merge (via mergePlaceholderUser, same logic as the
 *                        register-time fix).
 * Zero matches       -> left alone, logged.
 * Multiple matches   -> flagged for manual review, logged, skipped.
 *
 * Usage:
 *   node scripts/mergePlaceholderUsers.mjs            # apply
 *   node scripts/mergePlaceholderUsers.mjs --dry-run  # report only
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

// A real account is one that either has a Mojang-style v4 UUID or has
// actually played on the server (has a game session).
const REAL_ACCOUNT_PREDICATE = `
  u.is_placeholder = 0
  AND (
    SUBSTRING(REPLACE(u.uuid, '-', ''), 13, 1) = '4'
    OR EXISTS (SELECT 1 FROM gameSessions gs WHERE gs.userId = u.userId)
  )
`;

async function findGhosts() {
  return query(`
    SELECT u.*
      FROM users u
     WHERE u.discordId IS NOT NULL
       AND u.account_registered IS NULL
       AND u.password_hash IS NULL
       AND SUBSTRING(REPLACE(u.uuid, '-', ''), 13, 1) <> '4'
       AND NOT EXISTS (SELECT 1 FROM gameSessions gs WHERE gs.userId = u.userId)
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

async function main() {
  console.log(
    `[merge-ghosts] Starting${DRY_RUN ? " (DRY RUN — no changes will be made)" : ""}`
  );

  const ghosts = await findGhosts();
  console.log(`[merge-ghosts] Found ${ghosts.length} candidate placeholder row(s)`);

  let merged = 0;
  let skippedNoMatch = 0;
  let skippedAmbiguous = 0;

  for (const ghost of ghosts) {
    const matches = await findRealMatches(ghost);

    if (matches.length === 0) {
      skippedNoMatch += 1;
      console.log(
        `[merge-ghosts] SKIP ghost userId=${ghost.userId} username="${ghost.username}" discordId=${ghost.discordId}: no real account found`
      );
      continue;
    }

    if (matches.length > 1) {
      skippedAmbiguous += 1;
      console.warn(
        `[merge-ghosts] MANUAL REVIEW ghost userId=${ghost.userId} username="${ghost.username}" discordId=${ghost.discordId}: ${matches.length} possible real accounts -> [${matches
          .map((m) => `${m.userId}:${m.username}`)
          .join(", ")}]`
      );
      continue;
    }

    const survivor = matches[0];
    console.log(
      `[merge-ghosts] MERGE ghost userId=${ghost.userId} ("${ghost.username}") -> real userId=${survivor.userId} ("${survivor.username}")`
    );

    if (DRY_RUN) {
      merged += 1;
      continue;
    }

    try {
      const summary = await mergePlaceholderUser(ghost.userId, survivor.userId);
      merged += 1;
      console.log(`[merge-ghosts]   done`, summary);
    } catch (error) {
      console.error(
        `[merge-ghosts]   FAILED to merge ghost userId=${ghost.userId}:`,
        error
      );
    }
  }

  console.log(
    `[merge-ghosts] Complete. merged=${merged} skippedNoMatch=${skippedNoMatch} skippedAmbiguous=${skippedAmbiguous}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[merge-ghosts] Fatal error:", error);
    process.exit(1);
  });
