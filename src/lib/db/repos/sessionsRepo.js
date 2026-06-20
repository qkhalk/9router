import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    sessionType: row.sessionType,
    tokenHash: row.tokenHash,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export async function createSession({ userId, sessionType, tokenHash, ipAddress = null, userAgent = null, ttlMs }) {
  if (!userId || !sessionType || !tokenHash) throw new Error("userId, sessionType and tokenHash are required");
  if (!ttlMs) throw new Error("ttlMs is required");
  const db = await getAdapter();
  const now = new Date().toISOString();
  const session = {
    id: uuidv4(),
    userId,
    sessionType,
    tokenHash,
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    revokedAt: null,
    createdAt: now,
  };
  db.run(
    `INSERT INTO sessions(id, userId, sessionType, tokenHash, ipAddress, userAgent, expiresAt, revokedAt, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [session.id, session.userId, session.sessionType, session.tokenHash, session.ipAddress, session.userAgent, session.expiresAt, session.revokedAt, session.createdAt]
  );
  return session;
}

export async function findSessionByTokenHash(tokenHash, sessionType = null) {
  if (!tokenHash) return null;
  const db = await getAdapter();
  if (sessionType) {
    return rowToSession(
      db.get(`SELECT * FROM sessions WHERE tokenHash = ? AND sessionType = ?`, [tokenHash, sessionType])
    );
  }
  return rowToSession(db.get(`SELECT * FROM sessions WHERE tokenHash = ?`, [tokenHash]));
}

export async function revokeSession(id) {
  if (!id) return false;
  const db = await getAdapter();
  const now = new Date().toISOString();
  const r = db.run(`UPDATE sessions SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL`, [now, id]);
  return (r?.changes ?? 0) > 0;
}

export async function revokeAllForUser(userId, sessionType = null) {
  if (!userId) return 0;
  const db = await getAdapter();
  const now = new Date().toISOString();
  if (sessionType) {
    return db.run(`UPDATE sessions SET revokedAt = ? WHERE userId = ? AND sessionType = ? AND revokedAt IS NULL`, [now, userId, sessionType]).changes ?? 0;
  }
  return db.run(`UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL`, [now, userId]).changes ?? 0;
}

export async function pruneExpiredSessions() {
  const db = await getAdapter();
  const now = new Date().toISOString();
  return db.run(`DELETE FROM sessions WHERE expiresAt < ?`, [now]).changes ?? 0;
}
