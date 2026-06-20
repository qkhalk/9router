// Pure helpers for session token generation + hashing.
// No runtime dependencies on next/headers or the DB so the helpers can be
// imported from tests, route handlers, and any non-Next context without
// pulling in the cookie/repo graph.
import crypto from "node:crypto";

export function generateSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token) {
  if (!token) throw new Error("token is required");
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
