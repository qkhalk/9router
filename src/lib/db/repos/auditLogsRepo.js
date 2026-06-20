import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeData: parseJson(row.beforeData, null),
    afterData: parseJson(row.afterData, null),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  };
}

export async function createAuditLog({ actorUserId = null, action, entityType = null, entityId = null, beforeData = null, afterData = null, ipAddress = null, userAgent = null }) {
  if (!action) throw new Error("action is required");
  const db = await getAdapter();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO auditLogs(id, actorUserId, action, entityType, entityId, beforeData, afterData, ipAddress, userAgent, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, actorUserId, action, entityType, entityId, beforeData ? stringifyJson(beforeData) : null, afterData ? stringifyJson(afterData) : null, ipAddress, userAgent, now]
  );
  return rowToLog(db.get(`SELECT * FROM auditLogs WHERE id = ?`, [id]));
}

export async function listAuditLogs({ actorUserId = null, action = null, limit = 100 } = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (actorUserId) { where.push("actorUserId = ?"); params.push(actorUserId); }
  if (action) { where.push("action = ?"); params.push(action); }
  const sql = `SELECT * FROM auditLogs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY createdAt DESC LIMIT ?`;
  return db.all(sql, [...params, limit]).map(rowToLog);
}
