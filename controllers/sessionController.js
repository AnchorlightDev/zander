import bcrypt from "bcrypt";
import crypto from "crypto";
import db from "./databaseController.js";

/** Failed guesses allowed before an emailed code is invalidated. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * Generate a 6-digit code for email verification and password resets.
 *
 * This used Math.random(), which is V8's xorshift128+: fast, but not a CSPRNG.
 * Its internal state can be recovered from a small number of observed outputs,
 * after which every subsequent value is predictable. Since this same generator
 * issues password-reset codes, an attacker able to sample the stream — by
 * requesting resets for an account they control — could predict the code
 * emailed to someone else and take over that account. Hashing the code at rest
 * and expiring it does not help if the value itself is guessable.
 *
 * crypto.randomInt draws from the CSPRNG and is uniform over [min, max).
 */
export async function generateVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

export async function createEmailVerification(userId, code, expiresAt) {
  const hashedCode = await bcrypt.hash(code, 10);

  return new Promise((resolve, reject) => {
    db.query(
      `DELETE FROM userEmailVerifications WHERE userId = ?`,
      [userId],
      function (deleteError) {
        if (deleteError) {
          return reject(deleteError);
        }

        db.query(
          `INSERT INTO userEmailVerifications (userId, codeHash, expiresAt) VALUES (?, ?, ?)`,
          [userId, hashedCode, expiresAt],
          function (error) {
            if (error) {
              return reject(error);
            }

            resolve(true);
          }
        );
      }
    );
  });
}

function runQuery(sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => (error ? reject(error) : resolve(results)));
  });
}

/**
 * Check an emailed code against the latest row for a user.
 *
 * A 6-digit code is only safe while guesses are bounded, and the bound must
 * hold under concurrency: each guess first claims an attempt with a
 * conditional UPDATE (only one request can take the last slot), and only then
 * spends time in bcrypt. A read-then-increment let parallel requests all see
 * attempts = 0 and guess without limit. Consuming a matched code is likewise
 * conditional, so a code is single-use even if two correct guesses race.
 *
 * `table` and `idColumn` are fixed identifiers from this module, never input.
 */
export async function verifyStoredCode(table, idColumn, userId, code) {
  const rows = await runQuery(
    `SELECT * FROM ${table} WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
    [userId]
  );
  if (!rows || !rows.length) return { valid: false };

  const row = rows[0];
  if (row.consumed) return { valid: false, reason: "consumed" };
  if (new Date(row.expiresAt) < new Date()) return { valid: false, reason: "expired" };

  const claim = await runQuery(
    `UPDATE ${table} SET attempts = attempts + 1
      WHERE ${idColumn} = ? AND consumed = 0 AND attempts < ?`,
    [row[idColumn], MAX_CODE_ATTEMPTS]
  );
  if (!claim || claim.affectedRows !== 1) {
    // Out of attempts (or consumed meanwhile): burn it so the UI says so.
    await runQuery(`UPDATE ${table} SET consumed = 1 WHERE ${idColumn} = ?`, [row[idColumn]]);
    return { valid: false, reason: "consumed" };
  }

  const match = await bcrypt.compare(String(code), row.codeHash);
  if (!match) {
    await runQuery(
      `UPDATE ${table} SET consumed = 1 WHERE ${idColumn} = ? AND attempts >= ?`,
      [row[idColumn], MAX_CODE_ATTEMPTS]
    );
    return { valid: false, reason: "mismatch" };
  }

  const consume = await runQuery(
    `UPDATE ${table} SET consumed = 1, consumedAt = NOW() WHERE ${idColumn} = ? AND consumed = 0`,
    [row[idColumn]]
  );
  if (!consume || consume.affectedRows !== 1) return { valid: false, reason: "consumed" };
  return { valid: true };
}

export async function verifyEmailCode(userId, code) {
  return verifyStoredCode("userEmailVerifications", "verificationId", userId, code);
}

export async function createPasswordResetRequest(userId, code, expiresAt) {
  const hashedCode = await bcrypt.hash(code, 10);

  return new Promise((resolve, reject) => {
    db.query(
      `DELETE FROM userPasswordResets WHERE userId = ?`,
      [userId],
      function (deleteError) {
        if (deleteError) {
          return reject(deleteError);
        }

        db.query(
          `INSERT INTO userPasswordResets (userId, codeHash, expiresAt) VALUES (?, ?, ?)`,
          [userId, hashedCode, expiresAt],
          function (error) {
            if (error) {
              return reject(error);
            }

            resolve(true);
          }
        );
      }
    );
  });
}

export async function verifyPasswordResetCode(userId, code) {
  return verifyStoredCode("userPasswordResets", "resetId", userId, code);
}
