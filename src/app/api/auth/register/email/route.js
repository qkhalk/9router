import { readJsonBody, jsonError, jsonOk } from "@/lib/auth/_response.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";
import { issueOtp } from "@/lib/auth/email.js";
import { OTP_PURPOSES } from "@/lib/auth/otp.js";
import { checkRateLimit, limits } from "@/lib/rateLimit/index.js";
import { getAdapter } from "@/lib/db/driver.js";
import bcrypt from "bcryptjs";
import { createUserSync, getUserByEmail } from "@/lib/db/repos/usersRepo.js";
import { createIdentitySync } from "@/lib/db/repos/authIdentitiesRepo.js";
import { isDomainAllowed } from "@/lib/db/repos/allowedEmailDomainsRepo.js";
import * as securityEvents from "@/lib/db/repos/securityEventsRepo.js";
import { audit, AUDIT_ACTIONS } from "@/lib/audit/log.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";

export const dynamic = "force-dynamic";

const BCRYPT_COST = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }
  const { email, password, turnstileToken } = body;
  if (!email || !password || typeof password !== "string") {
    return jsonError("email and password are required", 400);
  }
  if (password.length < 8) {
    return jsonError("Password must be at least 8 characters", 400);
  }
  if (!EMAIL_RE.test(String(email))) {
    return jsonError("Invalid email format", 400);
  }

  const ip = getClientIp(request);

  // 1. Turnstile (fail-closed in prod; dev bypass for local).
  const turnstile = await verifyTurnstile({ token: turnstileToken, request, action: "register" });
  if (!turnstile.ok) {
    await securityEvents.recordSecurityEvent({
      eventType: "TURNSTILE_FAIL",
      ipAddress: ip,
      userAgent: request.headers.get("user-agent"),
      metadata: { stage: "register", error: turnstile.error },
    });
    return jsonError("Turnstile verification failed", 400, { reason: turnstile.error });
  }

  // 2. Rate limit: 3/h and 5/day per IP.
  const rate = checkRateLimit({
    key: `register-email:${ip}`,
    limits: [limits.perHour(3), limits.perDay(5)],
  });
  if (!rate.ok) {
    return jsonError("Too many registration attempts", 429, {
      retryAfterMs: rate.retryAfterMs,
      limit: rate.label,
    });
  }

  // 3. Domain allowlist.
  const allowed = await isDomainAllowed(email);
  if (!allowed) {
    await audit({ action: AUDIT_ACTIONS.AUTH_REGISTER_FAIL, request, afterData: { email, reason: "domain_not_allowed" } });
    return jsonError("Email domain is not allowed", 400);
  }

  // 4. Email must be unique.
  const existing = await getUserByEmail(email);
  if (existing) {
    await audit({ action: AUDIT_ACTIONS.AUTH_REGISTER_FAIL, request, afterData: { email, reason: "email_exists" } });
    return jsonError("Email already registered", 409);
  }

  // 5. Hash password + insert user + identity (single transaction so a
  // unique-constraint race on authIdentities doesn't leave an orphaned user).
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const db = await getAdapter();
  let user;
  db.transaction(() => {
    user = createUserSync(db, {
      email,
      passwordHash,
      role: "CLIENT",
      status: "PENDING_VERIFICATION",
    });
    createIdentitySync(db, {
      userId: user.id,
      provider: "password",
      providerAccountId: user.id,
      providerEmail: user.email,
      emailVerified: false,
    });
  });

  // 6. Issue OTP (returns devOtp only in dev/no-SMTP mode — never surface to caller).
  const challenge = await issueOtp({
    userId: user.id,
    email: user.email,
    purpose: OTP_PURPOSES.EMAIL_REGISTRATION,
    request,
  });

  await audit({
    actorUserId: user.id,
    action: AUDIT_ACTIONS.AUTH_REGISTER,
    entityType: "user",
    entityId: user.id,
    request,
    afterData: { challengeId: challenge.id },
  });

  return jsonOk({
    userId: user.id,
    challengeId: challenge.id,
    // Dev surface (only present when SMTP isn't configured). Never expose in prod.
    ...(process.env.NODE_ENV !== "production" && challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
  }, { status: 201 });
}
