import { readJsonBody, jsonError, jsonOk } from "@/lib/auth/_response.js";
import { hashOtpForUser } from "@/lib/auth/otp.js";
import {
  findActiveOtpByEmail,
  incrementOtpAttempts,
  invalidateOtp,
  markOtpConsumed,
} from "@/lib/db/repos/otpChallengesRepo.js";
import * as usersRepo from "@/lib/db/repos/usersRepo.js";
import { createClientSession, setClientSessionCookie } from "@/lib/auth/clientSession.js";
import { audit, AUDIT_ACTIONS } from "@/lib/audit/log.js";
import * as securityEvents from "@/lib/db/repos/securityEventsRepo.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400);
  const { userId, otp, turnstileToken } = body;
  if (!userId || !otp) return jsonError("userId and otp are required", 400);
  if (!/^\d{4,8}$/.test(String(otp))) return jsonError("OTP format invalid", 400);

  if (turnstileToken) {
    const t = await verifyTurnstile({ token: turnstileToken, request, action: "verify" });
    if (!t.ok) return jsonError("Turnstile verification failed", 400, { reason: t.error });
  }

  const user = await usersRepo.getUserById(userId);
  if (!user) return jsonError("User not found", 404);

  const target = await findActiveOtpByEmail(user.email, "EMAIL_REGISTRATION");
  if (!target) {
    await securityEvents.recordSecurityEvent({ userId: user.id, eventType: "OTP_FAIL", ipAddress: getClientIp(request), metadata: { stage: "verify-registration", reason: "no_active" } });
    return jsonError("No active OTP challenge. Request a new one.", 400);
  }

  const expected = hashOtpForUser({ otp, userId: user.id, email: user.email });
  if (expected !== target.otpHash) {
    const updated = await incrementOtpAttempts(target.id);
    if (updated.attempts >= updated.maxAttempts) {
      await invalidateOtp(target.id);
      await securityEvents.recordSecurityEvent({ userId: user.id, eventType: "OTP_FAIL", riskScore: 80, ipAddress: getClientIp(request), metadata: { stage: "verify-registration", reason: "max_attempts" } });
      return jsonError("Too many invalid attempts. Request a new code.", 429);
    }
    await securityEvents.recordSecurityEvent({ userId: user.id, eventType: "OTP_FAIL", ipAddress: getClientIp(request), metadata: { stage: "verify-registration", reason: "bad_otp" } });
    return jsonError("Invalid OTP", 400, { attemptsLeft: updated.maxAttempts - updated.attempts });
  }

  // Success — mark consumed, flip user to ACTIVE, mint session.
  await markOtpConsumed(target.id);
  await usersRepo.setEmailVerified(user.id);
  await usersRepo.setLastLogin(user.id);

  const { token } = await createClientSession({ userId: user.id, request });
  await setClientSessionCookie({ token, request });

  await audit({ actorUserId: user.id, action: AUDIT_ACTIONS.AUTH_VERIFY_OTP, entityType: "user", entityId: user.id, request, afterData: { challengeId: target.id } });

  return jsonOk({ userId: user.id });
}
