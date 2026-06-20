// Role-based access control. Two guards:
//   - requireClientSession(): accepts any valid client session
//   - requireAdminRole(allowedRoles = ADMIN_ROLES): accepts an admin session
//     whose user.role ∈ allowedRoles AND user.status === 'ACTIVE'
// Each returns a guard function: (request) → { ok, response, user?, session? }
// so route handlers can early-return the `response` on failure.
import { NextResponse } from "next/server";
import { verifyAdminSession, ADMIN_ROLES, hasAdminRole } from "./adminSession.js";
import { verifyClientSession } from "./clientSession.js";

export const ROLES = {
  CLIENT: "CLIENT",
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  SUPPORT: "SUPPORT",
  AUDITOR: "AUDITOR",
};

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

export function requireClientSession() {
  return async function guard(request) {
    const session = await verifyClientSession(request);
    if (!session) {
      return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    return { ok: true, session };
  };
}

export function requireAdminRole(allowedRoles = ADMIN_ROLES) {
  return async function guard(request) {
    const result = await verifyAdminSession(request);
    if (!result) {
      return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (!hasAdminRole(result.user, allowedRoles)) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { ok: true, user: result.user, session: result.session };
  };
}
