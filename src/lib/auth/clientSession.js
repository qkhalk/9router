// Client session — `__Host-client_session` cookie bound to a sessions row.
// Cookie is HttpOnly + Secure (when request is HTTPS) + SameSite=Lax + Path=/.
// The `__Host-` prefix forces Secure=true and Path=/ with no Domain attribute;
// when running over plain HTTP locally we fall back to a non-prefixed name so
// the cookie still works.
import { cookies } from "next/headers";
import * as sessionsRepo from "@/lib/db/repos/sessionsRepo.js";
import { getClientIp } from "./loginLimiter.js";
import { generateSessionToken, hashSessionToken } from "./sessionToken.js";

export { generateSessionToken, hashSessionToken };

export const CLIENT_SESSION_COOKIE = "__Host-client_session";
export const CLIENT_SESSION_COOKIE_DEV = "client_session"; // HTTP dev fallback
export const CLIENT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function isSecureRequest(request) {
  if (!request) return process.env.NODE_ENV === "production";
  if (request.headers?.get?.("x-forwarded-proto") === "https") return true;
  if (typeof request.url === "string" && request.url.startsWith("https://")) return true;
  return process.env.AUTH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
}

function cookieName(request) {
  return isSecureRequest(request) ? CLIENT_SESSION_COOKIE : CLIENT_SESSION_COOKIE_DEV;
}

export async function createClientSession({ userId, request = null, ttlMs = CLIENT_SESSION_TTL_MS } = {}) {
  if (!userId) throw new Error("userId is required");
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const session = await sessionsRepo.createSession({
    userId,
    sessionType: "client",
    tokenHash,
    ipAddress: request ? getClientIp(request) : null,
    userAgent: request?.headers?.get?.("user-agent") || null,
    ttlMs,
  });
  return { token, session };
}

export async function setClientSessionCookie({ token, request = null, ttlMs = CLIENT_SESSION_TTL_MS } = {}) {
  const cookieStore = await cookies();
  const name = cookieName(request);
  const secure = isSecureRequest(request);
  cookieStore.set(name, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export async function clearClientSessionCookie(request = null) {
  const cookieStore = await cookies();
  const name = cookieName(request);
  cookieStore.delete(name);
  if (name !== CLIENT_SESSION_COOKIE_DEV) {
    cookieStore.delete(CLIENT_SESSION_COOKIE_DEV);
  } else {
    cookieStore.delete(CLIENT_SESSION_COOKIE);
  }
}

export async function verifyClientSession(request) {
  if (!request) return null;
  const name = cookieName(request);
  // Try both names — a stale dev cookie may still be in the jar after
  // upgrading to HTTPS, and vice versa.
  const token = request.cookies?.get?.(name)?.value
    || request.cookies?.get?.(CLIENT_SESSION_COOKIE)?.value
    || request.cookies?.get?.(CLIENT_SESSION_COOKIE_DEV)?.value;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = await sessionsRepo.findSessionByTokenHash(tokenHash, "client");
  if (!session) return null;
  if (session.revokedAt) return null;
  if (new Date(session.expiresAt) < new Date()) return null;
  return session;
}

export async function readClientSessionToken(request) {
  if (!request) return null;
  const name = cookieName(request);
  return request.cookies?.get?.(name)?.value
    || request.cookies?.get?.(CLIENT_SESSION_COOKIE)?.value
    || request.cookies?.get?.(CLIENT_SESSION_COOKIE_DEV)?.value
    || null;
}
