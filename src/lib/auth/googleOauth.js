// Google OAuth — Authorization Code + PKCE flow.
// The Authorization Code + PKCE + state + nonce pattern matches the spec in
// plans/phase-01-db-auth.md §1.3. State / nonce / code_verifier are stored in
// HttpOnly cookies (not server-side state) so we don't need a backing store
// during the redirect round-trip.
import crypto from "node:crypto";
import { cookies } from "next/headers";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const DEFAULT_SCOPES = ["openid", "email", "profile"];

const STATE_COOKIE = "google_oauth_state";
const NONCE_COOKIE = "google_oauth_nonce";
const VERIFIER_COOKIE = "google_oauth_verifier";

function isSecureRequest(request) {
  if (!request) return process.env.NODE_ENV === "production";
  if (request.headers?.get?.("x-forwarded-proto") === "https") return true;
  if (typeof request.url === "string" && request.url.startsWith("https://")) return true;
  return process.env.AUTH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
}

function requireGoogleEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  return { clientId, clientSecret, redirectUri };
}

export function isGoogleOauthConfigured() {
  const { clientId, clientSecret, redirectUri } = requireGoogleEnv();
  return !!(clientId && clientSecret && redirectUri);
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildGoogleAuthUrl({ state, nonce, codeChallenge, scopes = DEFAULT_SCOPES, loginHint = null }) {
  const { clientId, redirectUri } = requireGoogleEnv();
  if (!clientId || !redirectUri) throw new Error("Google OAuth env not configured");
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export async function persistGoogleOAuthCookies({ request = null, state, nonce, codeVerifier, ttlMs = 10 * 60 * 1000 } = {}) {
  const cookieStore = await cookies();
  const secure = isSecureRequest(request);
  const maxAge = Math.floor(ttlMs / 1000);
  const baseOpts = { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge };
  cookieStore.set(STATE_COOKIE, state, baseOpts);
  cookieStore.set(NONCE_COOKIE, nonce, baseOpts);
  cookieStore.set(VERIFIER_COOKIE, codeVerifier, baseOpts);
}

export async function readGoogleOAuthCookies(request) {
  if (!request) return null;
  const state = request.cookies?.get?.(STATE_COOKIE)?.value;
  const nonce = request.cookies?.get?.(NONCE_COOKIE)?.value;
  const codeVerifier = request.cookies?.get?.(VERIFIER_COOKIE)?.value;
  if (!state || !nonce || !codeVerifier) return null;
  return { state, nonce, codeVerifier };
}

export async function clearGoogleOAuthCookies() {
  const cookieStore = await cookies();
  cookieStore.delete(STATE_COOKIE);
  cookieStore.delete(NONCE_COOKIE);
  cookieStore.delete(VERIFIER_COOKIE);
}

// Exchange the authorization code for tokens, then verify the id_token's
// signature, audience, and email_verified claim. Returns the normalized
// profile: { sub, email, email_verified, name, picture }.
export async function exchangeGoogleCode({ code, codeVerifier, nonce }) {
  const { clientId, clientSecret, redirectUri } = requireGoogleEnv();
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Google OAuth env not configured");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    const err = new Error(tokenData?.error_description || tokenData?.error || `Google token exchange failed (${tokenRes.status})`);
    err.status = tokenRes.status;
    err.body = tokenData;
    throw err;
  }

  const idToken = tokenData.id_token;
  if (!idToken) {
    const err = new Error("Google token response missing id_token");
    err.body = tokenData;
    throw err;
  }

  // Verify id_token signature/aud/iss/exp using JWKS.
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });

  if (nonce && payload.nonce !== nonce) {
    const err = new Error("Google id_token nonce mismatch");
    throw err;
  }
  if (payload.email_verified !== true) {
    const err = new Error("Google account email is not verified");
    err.code = "email_unverified";
    throw err;
  }

  return {
    sub: payload.sub,
    email: (payload.email || "").toLowerCase(),
    email_verified: payload.email_verified === true,
    name: payload.name || null,
    picture: payload.picture || null,
  };
}
