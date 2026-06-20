import { readJsonBody, jsonError, jsonOk } from "@/lib/auth/_response.js";
import { verifyTurnstile } from "@/lib/auth/turnstile.js";
import { checkRateLimit, limits } from "@/lib/rateLimit/index.js";
import {
  buildGoogleAuthUrl,
  clearGoogleOAuthCookies,
  createPkcePair,
  exchangeGoogleCode,
  isGoogleOauthConfigured,
  persistGoogleOAuthCookies,
  readGoogleOAuthCookies,
} from "@/lib/auth/googleOauth.js";
import * as usersRepo from "@/lib/db/repos/usersRepo.js";
import * as identitiesRepo from "@/lib/db/repos/authIdentitiesRepo.js";
import * as domainsRepo from "@/lib/db/repos/allowedEmailDomainsRepo.js";
import * as securityEvents from "@/lib/db/repos/securityEventsRepo.js";
import { createClientSession, setClientSessionCookie } from "@/lib/auth/clientSession.js";
import { audit, AUDIT_ACTIONS } from "@/lib/audit/log.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

// Phase 1 register/google implements the "back-channel" code exchange path so
// the React client only sees { success: true } after Google verifies the id_token.
// The state/nonce/verifier round-trip is performed by the server via cookies.
// Two body shapes:
//   1) { step: "start" }                  → returns { authUrl, state, nonce }
//   2) { step: "finish", code, state }    → exchanges code, mints session
export async function POST(request) {
  if (!isGoogleOauthConfigured()) return jsonError("Google OAuth not configured", 501);

  const body = await readJsonBody(request);
  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400);

  // ─── Start step: build auth URL, persist state/nonce/verifier ───────────
  if (body.step === "start") {
    const ip = getClientIp(request);
    const turnstile = await verifyTurnstile({ token: body.turnstileToken, request, action: "google-start" });
    if (!turnstile.ok) {
      await securityEvents.recordSecurityEvent({ eventType: "TURNSTILE_FAIL", ipAddress: ip, metadata: { stage: "google-start" } });
      return jsonError("Turnstile verification failed", 400, { reason: turnstile.error });
    }
    const rl = checkRateLimit({
      key: `google-start:${ip}`,
      limits: [limits.perHour(10), limits.perDay(30)],
    });
    if (!rl.ok) return jsonError("Too many requests", 429, { retryAfterMs: rl.retryAfterMs });

    const state = crypto.randomBytes(16).toString("base64url");
    const nonce = crypto.randomBytes(16).toString("base64url");
    const { verifier, challenge } = createPkcePair();
    await persistGoogleOAuthCookies({ request, state, nonce, codeVerifier: verifier });
    const authUrl = buildGoogleAuthUrl({ state, nonce, codeChallenge: challenge, loginHint: body.loginHint || null });
    await audit({ action: "auth.google.start", request, afterData: { state } });
    return jsonOk({ authUrl, state, nonce });
  }

  // ─── Finish step: verify state + nonce, exchange code, mint session ─────
  if (body.step === "finish") {
    const cookies = await readGoogleOAuthCookies(request);
    if (!cookies) return jsonError("OAuth session expired. Restart the flow.", 400);
    if (cookies.state !== body.state) {
      await securityEvents.recordSecurityEvent({ eventType: "OAUTH_STATE_MISMATCH", ipAddress: getClientIp(request), metadata: { stage: "google-finish" } });
      await clearGoogleOAuthCookies();
      return jsonError("OAuth state mismatch", 400);
    }

    let profile;
    try {
      profile = await exchangeGoogleCode({ code: body.code, codeVerifier: cookies.codeVerifier, nonce: cookies.nonce });
    } catch (e) {
      if (e?.code === "email_unverified") {
        return jsonError("Google account email is not verified", 400);
      }
      await securityEvents.recordSecurityEvent({ eventType: "OAUTH_EXCHANGE_FAIL", ipAddress: getClientIp(request), metadata: { error: e?.message } });
      return jsonError("OAuth exchange failed", 400, { reason: e?.message });
    }
    await clearGoogleOAuthCookies();

    if (!profile.email_verified) return jsonError("Google account email is not verified", 400);

    const allowed = await domainsRepo.isDomainAllowed(profile.email);
    if (!allowed) {
      await audit({ action: AUDIT_ACTIONS.AUTH_REGISTER_FAIL, request, afterData: { email: profile.email, provider: "google", reason: "domain_not_allowed" } });
      return jsonError("Email domain is not allowed", 400);
    }

    // Reuse identity if it exists, otherwise create user + identity.
    let user = await usersRepo.getUserByEmail(profile.email);
    let identity = user ? await identitiesRepo.findIdentity("google", profile.sub) : null;
    if (!user) {
      user = await usersRepo.createUser({
        email: profile.email,
        username: profile.name || null,
        role: "CLIENT",
        status: "ACTIVE", // Google already verified the email
      });
      await usersRepo.updateUser(user.id, { emailVerifiedAt: new Date().toISOString() });
    } else if (user.status === "PENDING_VERIFICATION") {
      await usersRepo.setEmailVerified(user.id);
    }
    if (!identity) {
      identity = await identitiesRepo.createIdentity({
        userId: user.id,
        provider: "google",
        providerAccountId: profile.sub,
        providerEmail: profile.email,
        emailVerified: true,
      });
    } else {
      await identitiesRepo.touchIdentityLastLogin(identity.id);
    }

    await usersRepo.setLastLogin(user.id);
    const { token } = await createClientSession({ userId: user.id, request });
    await setClientSessionCookie({ token, request });

    await audit({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS,
      entityType: "user",
      entityId: user.id,
      request,
      afterData: { provider: "google" },
    });

    return jsonOk({ userId: user.id, newAccount: !identity });
  }

  return jsonError("Unknown step. Use 'start' or 'finish'.", 400);
}
