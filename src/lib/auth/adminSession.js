// Admin session — `__Secure-admin_session` cookie + role gate.
// Same shape as clientSession but sessionType='admin', TTL 8h, SameSite=Strict,
// and the verify step requires users.role ∈ {SUPER_ADMIN, ADMIN, SUPPORT, AUDITOR}.
import { cookies } from "next/headers";
import * as sessionsRepo from "@/lib/db/repos/sessionsRepo.js";
import * as usersRepo from "@/lib/db/repos/usersRepo.js";
import { hashSessionToken, generateSessionToken, setClientSessionCookie } from "./clientSession.js";
import { getClientIp } from "./loginLimiter.js";

export const ADMIN_SESSION_COOKIE = "__Secure-admin_session";
export const ADMIN_SESSION_COOKIE_DEV = "admin_session";
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

export const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN", "SUPPORT", "AUDITOR"];

function isSecureRequest(request) {
  if (!request) return process.env.NODE_ENV === "production";
  if (request.headers?.get?.("x-forwarded-proto") === "https") return true;
  if (typeof request.url === "string" && request.url.startsWith("https://")) return true;
  return process.env.AUTH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
}

function cookieName(request) {
  return isSecureRequest(request) ? ADMIN_SESSION_COOKIE : ADMIN_SESSION_COOKIE_DEV;
}

export async function createAdminSession({ userId, request = null, ttlMs = ADMIN_SESSION_TTL_MS } = {}) {
  if (!userId) throw new Error("userId is required");
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const session = await sessionsRepo.createSession({
    userId,
    sessionType: "admin",
    tokenHash,
    ipAddress: request ? getClientIp(request) : null,
    userAgent: request?.headers?.get?.("user-agent") || null,
    ttlMs,
  });
  return { token, session };
}

export async function setAdminSessionCookie({ token, request = null, ttlMs = ADMIN_SESSION_TTL_MS } = {}) {
  const cookieStore = await cookies();
  const name = cookieName(request);
  const secure = isSecureRequest(request);
  cookieStore.set(name, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export async function clearAdminSessionCookie(request = null) {
  const cookieStore = await cookies();
  cookieStore.delete(cookieName(request));
  // Belt-and-suspenders: remove the alternate name too in case the request
  // arrived over a different transport than the one that set the cookie.
  cookieStore.delete(ADMIN_SESSION_COOKIE);
  cookieStore.delete(ADMIN_SESSION_COOKIE_DEV);
}

export async function verifyAdminSession(request) {
  if (!request) return null;
  const token = request.cookies?.get?.(cookieName(request))?.value
    || request.cookies?.get?.(ADMIN_SESSION_COOKIE)?.value
    || request.cookies?.get?.(ADMIN_SESSION_COOKIE_DEV)?.value;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = await sessionsRepo.findSessionByTokenHash(tokenHash, "admin");
  if (!session || session.revokedAt) return null;
  if (new Date(session.expiresAt) < new Date()) return null;
  const user = await usersRepo.getUserById(session.userId);
  if (!user) return null;
  if (!ADMIN_ROLES.includes(user.role)) return null;
  // PENDING_VERIFICATION users have not completed email verification and must
  // never reach admin-only paths even if their role is ADMIN. Phase 4 will
  // mint admin users via invite + first-login verify.
  if (user.status !== "ACTIVE") return null;
  return { session, user };
}

export function hasAdminRole(user, allowedRoles = ADMIN_ROLES) {
  if (!user) return false;
  return allowedRoles.includes(user.role);
}

// Convenience: promote a client session to admin on the same browser. Used
// when a SUPER_ADMIN upgrades their role inside the app.
export async function setAdminSessionFromClient({ userId, request = null } = {}) {
  const { token } = await createAdminSession({ userId, request });
  await setAdminSessionCookie({ token, request });
  return token;
}

// re-export for callers that don't want to import clientSession directly.
export { setClientSessionCookie };
