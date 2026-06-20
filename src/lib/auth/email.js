// Email delivery. Production uses SMTP (nodemailer-style via global fetch or
// the dynamic `nodemailer` import when available). Dev fallback: log OTP to
// console so local testing is friction-free.
import { generateOtp, OTP_DEFAULTS, OTP_PURPOSES, hashOtpForUser } from "./otp.js";
import { createOtpChallenge } from "@/lib/db/repos/otpChallengesRepo.js";
import { getClientIp } from "./loginLimiter.js";

let cachedTransport = null;
async function getTransport() {
  if (cachedTransport !== null) return cachedTransport;
  if (!process.env.SMTP_HOST) {
    cachedTransport = false; // dev fallback
    return cachedTransport;
  }
  try {
    const mod = await import("nodemailer").catch(() => null);
    if (!mod) {
      console.warn("[auth/email] SMTP_HOST set but nodemailer not installed; falling back to console log");
      cachedTransport = false;
      return cachedTransport;
    }
    const port = Number(process.env.SMTP_PORT) || 587;
    cachedTransport = mod.default.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    return cachedTransport;
  } catch (e) {
    console.warn(`[auth/email] SMTP setup failed: ${e?.message || e}; falling back to console log`);
    cachedTransport = false;
    return cachedTransport;
  }
}

export const __setEmailTransportForTest = (t) => { cachedTransport = t; };

function subjectFor(purpose) {
  switch (purpose) {
    case OTP_PURPOSES.EMAIL_REGISTRATION: return "Verify your 9Router account";
    case OTP_PURPOSES.EMAIL_LOGIN: return "Your 9Router login code";
    case OTP_PURPOSES.PASSWORD_RESET: return "Reset your 9Router password";
    case OTP_PURPOSES.CHANGE_EMAIL: return "Confirm your new 9Router email";
    case OTP_PURPOSES.SENSITIVE_ACTION: return "Your 9Router verification code";
    default: return "Your 9Router verification code";
  }
}

function bodyFor(purpose, otp, ttlMinutes) {
  return [
    `Your 9Router verification code is: ${otp}`,
    ``,
    `This code expires in ${ttlMinutes} minutes.`,
    `If you did not request this, you can ignore this email.`,
  ].join("\n");
}

// Issue + persist + send an OTP for a given purpose. Returns the persisted
// challenge row. In dev with no SMTP, the OTP is logged to the console and
// returned via `devOtp` for tests / dev tooling — production code MUST NOT
// surface devOtp to end users.
export async function issueOtp({ userId = null, email, purpose, request = null, ttlMs = OTP_DEFAULTS.TTL_MS, maxAttempts = OTP_DEFAULTS.MAX_ATTEMPTS } = {}) {
  if (!email || !purpose) throw new Error("email and purpose are required");
  const otp = generateOtp();
  const otpHash = hashOtpForUser({ otp, userId, email });
  const challenge = await createOtpChallenge({
    userId,
    email,
    purpose,
    otpHash,
    ttlMs,
    maxAttempts,
    createdIp: request ? getClientIp(request) : null,
  });

  const transport = await getTransport();
  if (!transport) {
    // Dev fallback — log the OTP to console so a developer can copy/paste it.
    console.log(`[auth/email] DEV OTP for ${email} (purpose=${purpose}, challenge=${challenge.id}): ${otp}`);
    return { ...challenge, devOtp: otp };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@router.local";
  const ttlMin = Math.max(1, Math.round(ttlMs / 60000));
  try {
    await transport.sendMail({
      from,
      to: email,
      subject: subjectFor(purpose),
      text: bodyFor(purpose, otp, ttlMin),
    });
  } catch (e) {
    // Don't fail the request — caller logs the failure and falls back to dev
    // surface so a misconfigured SMTP doesn't lock users out.
    console.error(`[auth/email] send failed for ${email}: ${e?.message || e}`);
    console.log(`[auth/email] DEV OTP fallback for ${email} (purpose=${purpose}, challenge=${challenge.id}): ${otp}`);
    return { ...challenge, devOtp: otp, sendError: e?.message || String(e) };
  }

  return challenge;
}
