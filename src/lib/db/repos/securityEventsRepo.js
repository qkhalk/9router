import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    eventType: row.eventType,
    riskScore: row.riskScore,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    ephemeralId: row.ephemeralId,
    metadata: parseJson(row.metadata, null),
    createdAt: row.createdAt,
  };
}

export async function recordSecurityEvent({ userId = null, eventType, riskScore = 0, ipAddress = null, userAgent = null, ephemeralId = null, metadata = null }) {
  if (!eventType) throw new Error("eventType is required");
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO securityEvents(id, userId, eventType, riskScore, ipAddress, userAgent, ephemeralId, metadata, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, eventType, riskScore, ipAddress, userAgent, ephemeralId, metadata ? stringifyJson(metadata) : null, now]
  );
  return rowToEvent(db.get(`SELECT * FROM securityEvents WHERE id = ?`, [id]));
}

export async function listSecurityEvents({ userId = null, eventType = null, limit = 100 } = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (userId) { where.push("userId = ?"); params.push(userId); }
  if (eventType) { where.push("eventType = ?"); params.push(eventType); }
  const sql = `SELECT * FROM securityEvents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY createdAt DESC LIMIT ?`;
  return db.all(sql, [...params, limit]).map(rowToEvent);
}
