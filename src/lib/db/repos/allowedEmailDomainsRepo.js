import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToDomain(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    isEnabled: row.isEnabled === 1 || row.isEnabled === true,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAllowedDomains({ enabledOnly = true } = {}) {
  const db = await getAdapter();
  if (enabledOnly) {
    return db.all(`SELECT * FROM allowedEmailDomains WHERE isEnabled = 1 ORDER BY domain ASC`).map(rowToDomain);
  }
  return db.all(`SELECT * FROM allowedEmailDomains ORDER BY domain ASC`).map(rowToDomain);
}

export async function findAllowedDomain(domain) {
  if (!domain) return null;
  const db = await getAdapter();
  return rowToDomain(db.get(`SELECT * FROM allowedEmailDomains WHERE domain = ?`, [String(domain).toLowerCase()]));
}

// Returns true if the table has zero rows (allow-all mode for self-hosted) or
// the domain is in the allowlist with isEnabled=1. Anything else is rejected.
export async function isDomainAllowed(email) {
  if (!email) return false;
  const domain = String(email).toLowerCase().split("@")[1];
  if (!domain) return false;
  const db = await getAdapter();
  const total = db.get(`SELECT COUNT(*) as c FROM allowedEmailDomains`)?.c ?? 0;
  if (total === 0) return true; // no allowlist configured → allow all
  const row = db.get(`SELECT isEnabled FROM allowedEmailDomains WHERE domain = ?`, [domain]);
  return !!(row && (row.isEnabled === 1 || row.isEnabled === true));
}

export async function createAllowedDomain({ domain, isEnabled = true, createdBy = null }) {
  if (!domain) throw new Error("domain is required");
  const db = await getAdapter();
  const now = new Date().toISOString();
  const row = {
    id: uuidv4(),
    domain: String(domain).toLowerCase(),
    isEnabled: isEnabled ? 1 : 0,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO allowedEmailDomains(id, domain, isEnabled, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [row.id, row.domain, row.isEnabled, row.createdBy, row.createdAt, row.updatedAt]
  );
  return rowToDomain(row);
}

export async function deleteAllowedDomain(id) {
  const db = await getAdapter();
  const r = db.run(`DELETE FROM allowedEmailDomains WHERE id = ?`, [id]);
  return (r?.changes ?? 0) > 0;
}
