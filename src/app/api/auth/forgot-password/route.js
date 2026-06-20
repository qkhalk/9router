import { readJsonBody, jsonError, jsonOk } from "@/lib/auth/_response.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";
import { checkRateLimit, limits } from "@/lib/rateLimit/index.js";
import { issueOtp } from "@/lib/auth/email.js";
import { OTP_PURPOSES } from "@/lib/auth/otp.js";
import * as usersRepo from "@/lib/db/repos/usersRepo.js";
import * as securityEvents from "@/lib/db/repos/securityEventsRepo.js";
import { audit, AUDIT_ACTIONS } from "@/lib/audit/log.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 600;

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

export async function POST(request) {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400);
  const { email, turnstileToken } = body;
  if (!email || !EMAIL_RE.test(String(email))) return jsonError("Invalid email", 400);

  const ip = getClientIp(request);
  const t = await verifyTurnstile({ token: turnstileToken, request, action: "forgot" });
  if (!t.ok) {
    await securityEvents.recordSecurityEvent({ eventType: "TURNSTILE_FAIL", ipAddress: ip, metadata: { stage: "forgot-password" } });
    return jsonError("Turnstile verification failed", 400, { reason: t.error });
  }

  // Per-IP cap so this can't be used as a free email-existence oracle across many addresses.
  const rl = checkRateLimit({
    key: `forgot-password:${ip}`,
    limits: [limits.perHour(10), limits.perDay(30)],
  });
  if (!rl.ok) return jsonError("Too many requests", 429, { retryAfterMs: rl.retryAfterMs });

  const startedAt = Date.now();
  const user = await usersRepo.getUserByEmail(email);
  if (user && user.status === "ACTIVE") {
    await issueOtp({ userId: user.id, email: user.email, purpose: OTP_PURPOSES.PASSWORD_RESET, request });
  }
  // Pad response time to obscure user existence.
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_DELAY_MS) await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS))));

  await audit({ action: AUDIT_ACTIONS.AUTH_FORGOT_PASSWORD, request, afterData: { email, userExisted: !!user } });
  // Always return success — don't leak whether the email is registered.
  return jsonOk({});
}
