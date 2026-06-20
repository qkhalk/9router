// OTP generation + hashing. Plaintext is never persisted; only otpHash lands
// in the otpChallenges row. The salt combines a per-user secret (userId when
// known, otherwise the email) with a global server-side OTP_SALT.
import crypto from "node:crypto";

const DEFAULT_OTP_LENGTH = 6;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RESEND_COOLDOWN_MS = 60 * 1000; // 60s
const DEFAULT_MAX_SEND_PER_HOUR = 5;
const DEFAULT_MAX_SEND_PER_DAY = 10;

let cachedSalt = null;
function getOtpSalt() {
  if (cachedSalt) return cachedSalt;
  const fromEnv = process.env.OTP_SALT;
  if (fromEnv) {
    cachedSalt = fromEnv;
    return cachedSalt;
  }
  // Fall back to first 32 bytes of ENCRYPTION_KEY_V1 / ENCRYPTION_KEY so dev
  // boxes without OTP_SALT still have a stable per-process secret.
  const fallback = process.env.ENCRYPTION_KEY_V1 || process.env.ENCRYPTION_KEY || "";
  if (fallback) {
    cachedSalt = fallback;
    return cachedSalt;
  }
  // Last resort: deterministic per-process secret (resets on restart, which
  // invalidates any in-flight OTPs — acceptable for dev only).
  cachedSalt = crypto.randomBytes(32).toString("hex");
  return cachedSalt;
}

// Tests can override the salt to make hashes stable.
export function __setOtpSaltForTest(value) { cachedSalt = value; }
export function __resetOtpSaltForTest() { cachedSalt = null; }

export function generateOtp({ length = DEFAULT_OTP_LENGTH } = {}) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, "0");
}

export function hashOtp(otp, salt) {
  if (!otp) throw new Error("otp is required");
  return crypto.createHash("sha256").update(String(otp) + String(salt || "")).digest("hex");
}

export function hashOtpForUser({ otp, userId, email }) {
  const userSecret = userId ? String(userId) : (email ? String(email).toLowerCase() : "");
  return hashOtp(otp, getOtpSalt() + ":" + userSecret);
}

export const OTP_DEFAULTS = {
  TTL_MS: DEFAULT_TTL_MS,
  MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS: DEFAULT_RESEND_COOLDOWN_MS,
  MAX_SEND_PER_HOUR: DEFAULT_MAX_SEND_PER_HOUR,
  MAX_SEND_PER_DAY: DEFAULT_MAX_SEND_PER_DAY,
};

export const OTP_PURPOSES = {
  EMAIL_REGISTRATION: "EMAIL_REGISTRATION",
  EMAIL_LOGIN: "EMAIL_LOGIN",
  PASSWORD_RESET: "PASSWORD_RESET",
  CHANGE_EMAIL: "CHANGE_EMAIL",
  SENSITIVE_ACTION: "SENSITIVE_ACTION",
};
