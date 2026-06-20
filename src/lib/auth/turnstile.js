// Cloudflare Turnstile verification.
// Production is fail-closed: missing secret, missing token, or verification
// failure → { ok: false }. In dev, TURNSTILE_DEV_BYPASS=true short-circuits
// to { ok: true, dev: true } so local testing isn't blocked.
import { getClientIp } from "./loginLimiter.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5_000;

function getDevBypass() {
  return process.env.TURNSTILE_DEV_BYPASS === "true" && process.env.NODE_ENV !== "production";
}

export async function verifyTurnstile({ token, request = null, action = null, ip = null }) {
  if (getDevBypass()) return { ok: true, dev: true };
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { ok: false, error: "missing_secret" };
  }
  if (!token) {
    return { ok: false, error: "missing_token" };
  }
  const resolvedIp = ip || (request ? getClientIp(request) : null);

  const body = new URLSearchParams({ secret, response: token });
  if (resolvedIp && resolvedIp !== "unknown") body.set("remoteip", resolvedIp);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    if (!data.success) {
      return { ok: false, error: "verification_failed", errorCodes: data["error-codes"] || [] };
    }
    if (action && data.action && data.action !== action) {
      return { ok: false, error: "action_mismatch" };
    }
    return { ok: true, hostname: data.hostname || null };
  } catch (e) {
    return { ok: false, error: "fetch_failed", detail: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}
