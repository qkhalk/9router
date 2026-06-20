import { readJsonBody, jsonError, jsonOk } from "@/lib/auth/_response.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";
import { checkRateLimit, limits } from "@/lib/rateLimit/index.js";
import bcrypt from "bcryptjs";
import { issueOtp } from "@/lib/auth/email.js";
import { OTP_PURPOSES } from "@/lib/auth/otp.js";
import * as usersRepo from "@/lib/db/repos/usersRepo.js";
import * as securityEvents from "@/lib/db/repos/securityEventsRepo.js";
import { audit, AUDIT_ACTIONS } from "@/lib/audit/log.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400);
  const { email, password, turnstileToken } = body;
  if (!email || !password) return jsonError("email and password are required", 400);
  if (!EMAIL_RE.test(String(email))) return jsonError("Invalid email format", 400);

  const ip = getClientIp(request);

  const t = await verifyTurnstile({ token: turnstileToken, request, action: "login" });
  if (!t.ok) {
    await securityEvents.recordSecurityEvent({ eventType: "TURNSTILE_FAIL", ipAddress: ip, userAgent: request.headers.get("user-agent"), metadata: { stage: "login", error: t.error } });
    return jsonError("Turnstile verification failed", 400, { reason: t.error });
  }

  // Rate limit: 5/15min per email + 20/15min per IP.
  const rl = checkRateLimit({
    key: `login-email:${email.toLowerCase()}`,
    limits: [limits.perWindow(5, 15 * 60 * 1000, "15m")],
  });
  if (!rl.ok) return jsonError("Too many login attempts for this email", 429, { retryAfterMs: rl.retryAfterMs });
  const rlIp = checkRateLimit({
    key: `login-email-ip:${ip}`,
    limits: [limits.perWindow(20, 15 * 60 * 1000, "15m-ip")],
  });
  if (!rlIp.ok) return jsonError("Too many login attempts from this IP", 429, { retryAfterMs: rlIp.retryAfterMs });

  const user = await usersRepo.getUserByEmail(email);
  // Constant-time-ish path: still call bcrypt even on missing user so timing
  // doesn't trivially leak account existence.
  const dummyHash = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Dxx3YQ3uY7Tzdk3P6jq3OQF9GdKQy";
  const candidate = user?.passwordHash || dummyHash;
  const ok = await bcrypt.compare(String(password), candidate);

  if (!user || !ok) {
    await securityEvents.recordSecurityEvent({ userId: user?.id || null, eventType: "LOGIN_FAIL", ipAddress: ip, userAgent: request.headers.get("user-agent"), metadata: { stage: "login-email" } });
    await audit({ action: AUDIT_ACTIONS.AUTH_LOGIN_FAIL, request, afterData: { email } });
    return jsonError("Invalid email or password", 401);
  }
  if (user.status !== "ACTIVE" && user.status !== "PENDING_VERIFICATION") {
    return jsonError("Account is not active", 403, { status: user.status });
  }

  // Password OK — issue OTP as second factor.
  const challenge = await issueOtp({
    userId: user.id,
    email: user.email,
    purpose: OTP_PURPOSES.EMAIL_LOGIN,
    request,
  });

  await audit({ actorUserId: user.id, action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS, entityType: "user", entityId: user.id, request, afterData: { stage: "password_ok", challengeId: challenge.id } });

  return jsonOk({
    challengeId: challenge.id,
    requiresOtp: true,
    ...(process.env.NODE_ENV !== "production" && challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
  });
}
