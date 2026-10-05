import bcrypt from "bcrypt";
import crypto from "crypto";
import db from "./databaseController.js";

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

export async function verifyEmailCode(userId, code) {
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT * FROM userEmailVerifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
      [userId],
      async function (error, results) {
        if (error) {
          return reject(error);
        }

        if (!results || !results.length) {
          return resolve({ valid: false });
        }

        const verification = results[0];

        if (verification.consumed) {
          return resolve({ valid: false, reason: "consumed" });
        }

        const expiryDate = new Date(verification.expiresAt);
        if (expiryDate < new Date()) {
          return resolve({ valid: false, reason: "expired" });
        }

        const match = await bcrypt.compare(code, verification.codeHash);

        if (!match) {
          return resolve({ valid: false, reason: "mismatch" });
        }

        db.query(
          `UPDATE userEmailVerifications SET consumed = 1, consumedAt = NOW() WHERE verificationId = ?`,
          [verification.verificationId],
          function (updateError) {
            if (updateError) {
              return reject(updateError);
            }

            resolve({ valid: true });
          }
        );
      }
    );
  });
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
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT * FROM userPasswordResets WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
      [userId],
      async function (error, results) {
        if (error) {
          return reject(error);
        }

        if (!results || !results.length) {
          return resolve({ valid: false });
        }

        const resetRequest = results[0];

        if (resetRequest.consumed) {
          return resolve({ valid: false, reason: "consumed" });
        }

        const expiryDate = new Date(resetRequest.expiresAt);
        if (expiryDate < new Date()) {
          return resolve({ valid: false, reason: "expired" });
        }

        const match = await bcrypt.compare(code, resetRequest.codeHash);

        if (!match) {
          return resolve({ valid: false, reason: "mismatch" });
        }

        db.query(
          `UPDATE userPasswordResets SET consumed = 1, consumedAt = NOW() WHERE resetId = ?`,
          [resetRequest.resetId],
          function (updateError) {
            if (updateError) {
              return reject(updateError);
            }

            resolve({ valid: true });
          }
        );
      }
    );
  });
}
