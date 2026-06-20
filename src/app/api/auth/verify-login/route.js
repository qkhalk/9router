import { readJsonBody, jsonError, jsonOk } from "@/lib/auth/_response.js";
import { hashOtpForUser } from "@/lib/auth/otp.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";
import {
  findActiveOtpById,
  incrementOtpAttempts,
  invalidateOtp,
  markOtpConsumed,
} from "@/lib/db/repos/otpChallengesRepo.js";
import * as usersRepo from "@/lib/db/repos/usersRepo.js";
import * as securityEvents from "@/lib/db/repos/securityEventsRepo.js";
import { createClientSession, setClientSessionCookie } from "@/lib/auth/clientSession.js";
import { audit, AUDIT_ACTIONS } from "@/lib/audit/log.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400);
  const { challengeId, otp, turnstileToken } = body;
  if (!challengeId || !otp) return jsonError("challengeId and otp are required", 400);

  if (turnstileToken) {
    const t = await verifyTurnstile({ token: turnstileToken, request, action: "verify" });
    if (!t.ok) return jsonError("Turnstile verification failed", 400, { reason: t.error });
  }

  const challenge = await findActiveOtpById(challengeId);
  if (!challenge) return jsonError("OTP challenge expired or already used", 400);

  // Resolve user from challenge (userId may be null on PASSWORD_RESET path).
  const user = challenge.userId ? await usersRepo.getUserById(challenge.userId) : null;
  const expected = hashOtpForUser({ otp, userId: challenge.userId, email: challenge.email });
  if (expected !== challenge.otpHash) {
    const updated = await incrementOtpAttempts(challenge.id);
    if (updated.attempts >= updated.maxAttempts) {
      await invalidateOtp(challenge.id);
      await securityEvents.recordSecurityEvent({ userId: challenge.userId, eventType: "OTP_FAIL", riskScore: 80, ipAddress: getClientIp(request), metadata: { stage: "verify-login", reason: "max_attempts" } });
      return jsonError("Too many invalid attempts. Request a new code.", 429);
    }
    return jsonError("Invalid OTP", 400, { attemptsLeft: updated.maxAttempts - updated.attempts });
  }

  await markOtpConsumed(challenge.id);

  if (user) {
    if (user.status === "PENDING_VERIFICATION") {
      await usersRepo.setEmailVerified(user.id);
    }
    await usersRepo.setLastLogin(user.id);
  }

  if (!user) return jsonError("User no longer exists", 404);

  const { token } = await createClientSession({ userId: user.id, request });
  await setClientSessionCookie({ token, request });

  await audit({ actorUserId: user.id, action: AUDIT_ACTIONS.AUTH_VERIFY_OTP, entityType: "user", entityId: user.id, request, afterData: { stage: "login" } });

  return jsonOk({ userId: user.id });
}
