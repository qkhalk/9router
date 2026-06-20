import { readJsonBody, jsonError, jsonOk } from "@/lib/auth/_response.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";
import { checkRateLimit, limits } from "@/lib/rateLimit/index.js";
import { issueOtp } from "@/lib/auth/email.js";
import { OTP_DEFAULTS } from "@/lib/auth/otp.js";
import {
  findActiveOtpById,
  supersedeOtp,
} from "@/lib/db/repos/otpChallengesRepo.js";
import * as usersRepo from "@/lib/db/repos/usersRepo.js";
import * as securityEvents from "@/lib/db/repos/securityEventsRepo.js";
import { audit, AUDIT_ACTIONS } from "@/lib/audit/log.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400);
  const { challengeId, turnstileToken } = body;
  if (!challengeId) return jsonError("challengeId is required", 400);

  const t = await verifyTurnstile({ token: turnstileToken, request, action: "resend" });
  if (!t.ok) {
    await securityEvents.recordSecurityEvent({ eventType: "TURNSTILE_FAIL", ipAddress: getClientIp(request), metadata: { stage: "resend-otp" } });
    return jsonError("Turnstile verification failed", 400, { reason: t.error });
  }

  const existing = await findActiveOtpById(challengeId);
  if (!existing) return jsonError("Challenge not found or already used", 404);

  // Cooldown: 60s since last send for this email+purpose.
  const ageMs = Date.now() - new Date(existing.createdAt).getTime();
  if (ageMs < OTP_DEFAULTS.RESEND_COOLDOWN_MS) {
    return jsonError("Please wait before requesting a new code", 429, {
      retryAfterMs: OTP_DEFAULTS.RESEND_COOLDOWN_MS - ageMs,
    });
  }

  // Cap per hour + per day per email.
  const rl = checkRateLimit({
    key: `resend-otp:${existing.email}:${existing.purpose}`,
    limits: [limits.perHour(OTP_DEFAULTS.MAX_SEND_PER_HOUR), limits.perDay(OTP_DEFAULTS.MAX_SEND_PER_DAY)],
  });
  if (!rl.ok) return jsonError("Resend limit reached", 429, { retryAfterMs: rl.retryAfterMs, limit: rl.label });

  await supersedeOtp(existing.id);

  const user = existing.userId ? await usersRepo.getUserById(existing.userId) : null;
  const challenge = await issueOtp({
    userId: existing.userId,
    email: existing.email,
    purpose: existing.purpose,
    request,
  });

  await audit({
    actorUserId: existing.userId,
    action: AUDIT_ACTIONS.AUTH_RESEND_OTP,
    entityType: user ? "user" : "email",
    entityId: existing.userId || existing.email,
    request,
    afterData: { oldChallengeId: existing.id, newChallengeId: challenge.id, purpose: existing.purpose },
  });

  return jsonOk({
    challengeId: challenge.id,
    ...(process.env.NODE_ENV !== "production" && challenge.devOtp ? { devOtp: challenge.devOtp } : {}),
  });
}
