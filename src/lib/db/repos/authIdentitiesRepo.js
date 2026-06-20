import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToIdentity(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    providerAccountId: row.providerAccountId,
    providerEmail: row.providerEmail,
    emailVerified: row.emailVerified === 1 || row.emailVerified === true,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

export async function findIdentity(provider, providerAccountId) {
  const db = await getAdapter();
  return rowToIdentity(
    db.get(`SELECT * FROM authIdentities WHERE provider = ? AND providerAccountId = ?`, [provider, providerAccountId])
  );
}

export async function listIdentitiesForUser(userId) {
  const db = await getAdapter();
  return db.all(`SELECT * FROM authIdentities WHERE userId = ? ORDER BY createdAt ASC`, [userId]).map(rowToIdentity);
}

export async function createIdentity({ userId, provider, providerAccountId, providerEmail = null, emailVerified = false }) {
  const db = await getAdapter();
  return createIdentitySync(db, { userId, provider, providerAccountId, providerEmail, emailVerified });
}

// Sync version for use inside db.transaction() — adapter's transaction wrapper
// calls the function synchronously so async repos can't be composed there.
export function createIdentitySync(db, { userId, provider, providerAccountId, providerEmail = null, emailVerified = false }) {
  if (!userId || !provider || !providerAccountId) throw new Error("userId, provider and providerAccountId are required");
  const now = new Date().toISOString();
  const id = {
    id: uuidv4(),
    userId,
    provider,
    providerAccountId,
    providerEmail: providerEmail ? String(providerEmail).toLowerCase() : null,
    emailVerified: emailVerified ? 1 : 0,
    createdAt: now,
    lastLoginAt: now,
  };
  db.run(
    `INSERT INTO authIdentities(id, userId, provider, providerAccountId, providerEmail, emailVerified, createdAt, lastLoginAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [id.id, id.userId, id.provider, id.providerAccountId, id.providerEmail, id.emailVerified, id.createdAt, id.lastLoginAt]
  );
  return id;
}

export async function touchIdentityLastLogin(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE authIdentities SET lastLoginAt = ? WHERE id = ?`, [now, id]);
}
