import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToChallenge(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    purpose: row.purpose,
    otpHash: row.otpHash,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    supersededAt: row.supersededAt,
    createdIp: row.createdIp,
    createdAt: row.createdAt,
  };
}

// Insert a new OTP challenge; supersede any unconsumed challenges for the
// same (email, purpose) so only the latest one is valid. Runs in a tx so the
// lookup + insert are atomic — otherwise a concurrent resend could lose the
// supersede step and leave two valid OTPs.
export async function createOtpChallenge({ userId = null, email, purpose, otpHash, ttlMs, maxAttempts = 5, createdIp = null }) {
  if (!email || !purpose || !otpHash) throw new Error("email, purpose and otpHash are required");
  if (!ttlMs) throw new Error("ttlMs is required");
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const createdAt = now.toISOString();
  const normalizedEmail = String(email).toLowerCase();

  db.transaction(() => {
    db.run(
      `UPDATE otpChallenges
         SET supersededAt = ?
       WHERE email = ? AND purpose = ? AND consumedAt IS NULL AND supersededAt IS NULL`,
      [createdAt, normalizedEmail, purpose]
    );
    db.run(
      `INSERT INTO otpChallenges(id, userId, email, purpose, otpHash, attempts, maxAttempts, expiresAt, consumedAt, supersededAt, createdIp, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [id, userId, normalizedEmail, purpose, otpHash, 0, maxAttempts, expiresAt, createdIp, createdAt]
    );
  });
  return rowToChallenge(
    db.get(`SELECT * FROM otpChallenges WHERE id = ?`, [id])
  );
}

export async function findActiveOtpById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToChallenge(
    db.get(
      `SELECT * FROM otpChallenges
        WHERE id = ? AND consumedAt IS NULL AND supersededAt IS NULL AND expiresAt > ?`,
      [id, new Date().toISOString()]
    )
  );
}

export async function findActiveOtpByEmail(email, purpose) {
  if (!email || !purpose) return null;
  const db = await getAdapter();
  return rowToChallenge(
    db.get(
      `SELECT * FROM otpChallenges
        WHERE email = ? AND purpose = ? AND consumedAt IS NULL AND supersededAt IS NULL AND expiresAt > ?
        ORDER BY createdAt DESC LIMIT 1`,
      [String(email).toLowerCase(), purpose, new Date().toISOString()]
    )
  );
}

export async function incrementOtpAttempts(id) {
  const db = await getAdapter();
  db.run(`UPDATE otpChallenges SET attempts = attempts + 1 WHERE id = ?`, [id]);
  return rowToChallenge(db.get(`SELECT * FROM otpChallenges WHERE id = ?`, [id]));
}

export async function markOtpConsumed(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE otpChallenges SET consumedAt = ? WHERE id = ? AND consumedAt IS NULL`, [now, id]);
}

// Block the challenge by setting consumedAt (used when attempts >= maxAttempts)
export async function invalidateOtp(id) {
  return markOtpConsumed(id);
}

export async function supersedeOtp(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE otpChallenges SET supersededAt = ? WHERE id = ? AND supersededAt IS NULL`, [now, id]);
}
