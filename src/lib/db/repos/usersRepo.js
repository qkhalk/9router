import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role,
    status: row.status,
    emailVerifiedAt: row.emailVerifiedAt,
    lastLoginAt: row.lastLoginAt,
    mfaSecretEncrypted: row.mfaSecretEncrypted,
    mfaEnabled: row.mfaEnabled === 1 || row.mfaEnabled === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getUserById(id) {
  const db = await getAdapter();
  return rowToUser(db.get(`SELECT * FROM users WHERE id = ?`, [id]));
}

export async function getUserByEmail(email) {
  if (!email) return null;
  const db = await getAdapter();
  return rowToUser(db.get(`SELECT * FROM users WHERE email = ?`, [String(email).toLowerCase()]));
}

export async function createUser({ email, username = null, passwordHash = null, role = "CLIENT", status = "PENDING_VERIFICATION" } = {}) {
  const db = await getAdapter();
  return createUserSync(db, { email, username, passwordHash, role, status });
}

// Sync version for use inside db.transaction() — adapter's transaction wrapper
// calls the function synchronously so async repos can't be composed there.
export function createUserSync(db, { email, username = null, passwordHash = null, role = "CLIENT", status = "PENDING_VERIFICATION" } = {}) {
  if (!email) throw new Error("email is required");
  const now = new Date().toISOString();
  const user = {
    id: uuidv4(),
    email: String(email).toLowerCase(),
    username,
    passwordHash,
    role,
    status,
    emailVerifiedAt: null,
    lastLoginAt: null,
    mfaSecretEncrypted: null,
    mfaEnabled: 0,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO users(id, email, username, passwordHash, role, status, emailVerifiedAt, lastLoginAt, mfaSecretEncrypted, mfaEnabled, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.username, user.passwordHash, user.role, user.status, user.emailVerifiedAt, user.lastLoginAt, user.mfaSecretEncrypted, user.mfaEnabled, user.createdAt, user.updatedAt]
  );
  return user;
}

export async function updateUser(id, patch) {
  const db = await getAdapter();
  const current = rowToUser(db.get(`SELECT * FROM users WHERE id = ?`, [id]));
  if (!current) return null;
  const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.run(
    `UPDATE users SET username = ?, passwordHash = ?, role = ?, status = ?, emailVerifiedAt = ?, lastLoginAt = ?, mfaSecretEncrypted = ?, mfaEnabled = ? WHERE id = ?`,
    [merged.username, merged.passwordHash, merged.role, merged.status, merged.emailVerifiedAt, merged.lastLoginAt, merged.mfaSecretEncrypted, merged.mfaEnabled ? 1 : 0, id]
  );
  return merged;
}

export async function setEmailVerified(userId) {
  const now = new Date().toISOString();
  return updateUser(userId, { status: "ACTIVE", emailVerifiedAt: now });
}

export async function setUserActive(userId) {
  return updateUser(userId, { status: "ACTIVE" });
}

export async function setLastLogin(userId) {
  return updateUser(userId, { lastLoginAt: new Date().toISOString() });
}

export { createUserSync };
