# Phase 1 — Database & Authentication

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Mở rộng schema với users / sessions / OTP / RBAC / Audit log; implement Google OAuth + Email+Password+OTP + Cloudflare Turnstile; tách cookie client (`__Host-client_session`) và admin (`__Secure-admin_session`); backward-compat với `auth_token` hiện tại.

## Phạm vi

**Trong scope:**
- Mở rộng `src/lib/db/schema.js` với users, authIdentities, sessions, otpChallenges, allowedEmailDomains, securityEvents, auditLogs (Phase 5 thêm requestLogs/Exchanges/Attempts).
- Postgres adapter **optional** qua env `DATABASE_URL` (Prisma hoặc Drizzle; MVP dùng Drizzle để nhẹ + giữ SQLite native cho dev).
- `src/lib/auth/googleOauth.js` — Authorization Code flow với state + nonce + PKCE.
- `src/lib/auth/turnstile.js` — verify token qua Cloudflare; Fail-Closed ở prod.
- `src/lib/auth/otp.js` — generate 6-digit, hash (SHA-256 + salt), TTL, attempts, resend cooldown, max-send/h.
- `src/lib/auth/clientSession.js` — tạo + verify session cookie `__Host-client_session`.
- `src/lib/auth/adminSession.js` — tạo + verify session cookie `__Secure-admin_session`.
- `src/lib/auth/rbac.js` — middleware check role.
- `src/lib/auth/email.js` — SMTP send OTP; dev fallback log OTP ra console.
- Routes mới:
  - `POST /api/auth/register/email`
  - `POST /api/auth/register/google`
  - `POST /api/auth/verify-registration`
  - `POST /api/auth/login/email`
  - `POST /api/auth/verify-login`
  - `POST /api/auth/resend-otp`
  - `POST /api/auth/forgot-password`
- `src/proxy.js` cập nhật guard cho các route mới (cho phép public; check session cho `/app/*`).

**Ngoài scope:**
- Client Portal UI (Phase 3).
- Admin Portal UI (Phase 4).
- Gateway key generation (Phase 2).
- Full request logging (Phase 5).
- Generation worker (Phase 6).

## Tasks

### 1.1. Schema mở rộng

Sửa `src/lib/db/schema.js` thêm các table:

```js
users, authIdentities, sessions, otpChallenges,
allowedEmailDomains, securityEvents, auditLogs
```

Theo schema ở plan tổng §31. Mỗi table có index cần thiết (`idx_users_email`, `idx_sessions_user`, `idx_otp_email_purpose`, `idx_audit_actor`).

### 1.2. Postgres adapter (optional)

Tạo `src/lib/db/adapters/postgresAdapter.js` chỉ load khi `DATABASE_URL` bắt đầu bằng `postgres://` hoặc `postgresql://`. Dùng `pg` package. Mapping `db.run / db.get / db.all / db.transaction` tương đương API hiện tại.

Driver `src/lib/db/driver.js` chọn adapter dựa trên `process.env.DATABASE_URL`.

### 1.3. Google OAuth

```js
// src/lib/auth/googleOauth.js
export function buildAuthUrl(state, nonce, codeChallenge) { ... }
export async function exchangeCode(code, codeVerifier) {
  // → Google token endpoint → {id_token, access_token}
  // verify id_token qua google-auth-library (hoặc jose + JWKS)
  // → {sub, email, email_verified, name, picture}
}
```

State + nonce lưu trong HttpOnly cookie tạm thời (TTL 10 phút). PKCE code_verifier giống cơ chế.

### 1.4. Cloudflare Turnstile

```js
// src/lib/auth/turnstile.js
export async function verifyTurnstile(token, ip, action) {
  if (process.env.TURNSTILE_DEV_BYPASS === 'true' && process.env.NODE_ENV !== 'production') {
    return { ok: true, dev: true };
  }
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
  });
  const data = await res.json();
  if (!data.success) return { ok: false, errorCodes: data['error-codes'] };
  if (action && data.action !== action) return { ok: false, error: 'action_mismatch' };
  return { ok: true };
}
```

Production: Fail-Closed. Mọi route auth gọi `verifyTurnstile` và reject nếu `!ok`.

### 1.5. OTP

```js
// src/lib/auth/otp.js
export function generateOtp() {
  // 6 chữ số, dùng crypto.randomInt
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
export function hashOtp(otp, salt) {
  return crypto.createHash('sha256').update(otp + salt).digest('hex');
}
```

Salt per-user lưu `users.id` + global salt từ env `OTP_SALT` (random 32 byte, set lần đầu).

`OtpChallenge` table:
- Insert: `id, userId, email, purpose, otpHash, attempts=0, maxAttempts=5, expiresAt, consumedAt=null, createdIp, createdAt`.
- New OTP insert → mark tất cả challenge cùng `(email, purpose, consumedAt IS NULL)` là `supersededAt = now()`.
- Verify: lookup unconsumed + not expired → compare hash → nếu khớp: `consumedAt = now()`; nếu lệch: `attempts++`, nếu `attempts >= maxAttempts` → invalidate (set `consumedAt = now()` để block).

### 1.6. Client Session

```js
// src/lib/auth/clientSession.js
const COOKIE = '__Host-client_session';

export async function createClientSession(userId, request) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await sessionsRepo.create({
    userId, sessionType: 'client', tokenHash,
    ipAddress: getClientIp(request),
    userAgent: request.headers.get('user-agent') || '',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  return token;
}

export async function setClientSessionCookie(cookieStore, token) {
  cookieStore.set(COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'lax',
    path: '/', maxAge: 7 * 24 * 3600,
  });
}

export async function verifyClientSession(request) {
  const token = request.cookies.get(COOKIE)?.value;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await sessionsRepo.findByTokenHash(tokenHash);
  if (!session || session.sessionType !== 'client') return null;
  if (session.revokedAt) return null;
  if (new Date(session.expiresAt) < new Date()) return null;
  return session;
}
```

### 1.7. Admin Session

Tương tự client session, `sessionType='admin'`, TTL 8h, cookie `__Secure-admin_session`, `sameSite='strict'`. Verify check `users.role` ∈ {`SUPER_ADMIN`, `ADMIN`, `SUPPORT`, `AUDITOR`}.

### 1.8. Routes mới

#### `POST /api/auth/register/email`
Body: `{ email, password, turnstileToken }`.
1. Verify Turnstile.
2. Check rate-limit: 3/h/IP, 5/day/IP.
3. Check domain allowlist.
4. Check email chưa tồn tại.
5. Hash password (bcrypt cost 12).
6. Insert `users` với `status='PENDING_VERIFICATION'`.
7. Insert `authIdentities` provider='password'.
8. Generate OTP, insert `otpChallenges` purpose=`EMAIL_REGISTRATION`.
9. Send email (hoặc log nếu dev).
10. Return `{ success: true, userId, challengeId }` (KHÔNG trả OTP).

#### `POST /api/auth/verify-registration`
Body: `{ userId, otp }`.
1. Lookup `otpChallenges` unconsumed + not expired + purpose=`EMAIL_REGISTRATION`.
2. Compare hash; nếu sai → `attempts++`; nếu ≥ max → block.
3. Nếu đúng → `consumedAt = now()`, `users.status = 'ACTIVE'`, `users.emailVerifiedAt = now()`.
4. Tạo client session, set cookie.
5. Return `{ success: true }`.

#### `POST /api/auth/register/google`
Body: `{ turnstileToken, state, nonce, code, codeVerifier }`.
1. Verify Turnstile.
2. Verify state + nonce từ cookie tạm.
3. Exchange code → Google tokens.
4. Verify `id_token` (signature, audience, email_verified=true).
5. Check domain allowlist.
6. Lookup user by email; nếu chưa có → tạo `users` ACTIVE + `authIdentities` provider='google'.
7. Tạo client session.
8. Return `{ success: true }`.

#### `POST /api/auth/login/email`
Body: `{ email, password, turnstileToken }`.
1. Verify Turnstile.
2. Check rate-limit 5/15min/email, 20/15min/IP.
3. Lookup user by email.
4. Verify password (bcrypt).
5. Insert `otpChallenges` purpose=`EMAIL_LOGIN`, gửi OTP.
6. Return `{ success: true, challengeId, requiresOtp: true }`.

#### `POST /api/auth/verify-login`
Body: `{ challengeId, otp }`.
1. Verify OTP như register.
2. Update `users.lastLoginAt`.
3. Tạo client session.
4. Return `{ success: true }`.

#### `POST /api/auth/resend-otp`
Body: `{ challengeId, turnstileToken }`.
1. Verify Turnstile.
2. Check cooldown 60s + max 5/h/email + max 10/day/email.
3. Mark old challenge `supersededAt = now()`.
4. Generate + insert + send new OTP.

#### `POST /api/auth/forgot-password`
Body: `{ email, turnstileToken }`.
1. Verify Turnstile.
2. Không leak user existence: luôn trả `{ success: true }` sau random delay 200–600ms.
3. Nếu user tồn tại + status ACTIVE → insert `otpChallenges` purpose=`PASSWORD_RESET`, gửi OTP.

### 1.9. Proxy/middleware update

`src/proxy.js`:
- Cho phép public các route `/api/auth/*` mới + `/`, `/login`, `/register`, `/verify-*`, `/forgot-password`.
- Path `/app/*`: yêu cầu `verifyClientSession`.
- Path `/dashboard/*` (admin): giữ behavior hiện tại với `auth_token` cookie (backward compat) HOẶC dùng `__Secure-admin_session` mới.
- Path `/<ADMIN_PATH_PREFIX>/*` và `/<ADMIN_API_PREFIX>/*`: yêu cầu admin session + RBAC.

### 1.10. Rate limit in-memory

Tạo `src/lib/rateLimit/index.js` (in-memory bucket per IP/email), sliding window 60s/15min/1h/day. Phase 7 chuyển sang Redis.

### 1.11. Audit log nền tảng

`src/lib/audit/log.js`:
```js
export async function audit({ actorUserId, action, entityType, entityId, beforeData, afterData, ip, ua }) {
  await auditLogsRepo.create({ ... });
}
```

Helper `withAudit(action, fn)` wrap route handler.

## Acceptance criteria

1. `users`, `authIdentities`, `sessions`, `otpChallenges`, `allowedEmailDomains`, `securityEvents`, `auditLogs` tables tồn tại sau boot.
2. `POST /api/auth/register/email` với domain ngoài allowlist → 400.
3. `POST /api/auth/register/email` thiếu Turnstile → 400.
4. `POST /api/auth/register/email` happy path → user PENDING + OTP gửi (hoặc log ở dev).
5. `POST /api/auth/verify-registration` OTP sai 5 lần → challenge block.
6. `POST /api/auth/verify-registration` OTP đúng → user ACTIVE + `__Host-client_session` cookie set.
7. `POST /api/auth/login/email` password sai 5 lần / 15min → 429.
8. `POST /api/auth/login/email` happy path → OTP gửi, response `requiresOtp: true`.
9. `POST /api/auth/verify-login` đúng → session cookie set.
10. `POST /api/auth/register/google` mock Google `email_verified=false` → 400.
11. `GET /app` không có session → redirect `/login` (chưa cần UI, chỉ check route guard).
12. `GET /dashboard` với `auth_token` legacy vẫn hoạt động (backward compat).
13. Mọi action `auth.login`, `auth.register`, `auth.view_request_content` (khi có) được ghi `auditLogs`.
14. OTP chỉ lưu `otpHash` (kiểm tra DB: KHÔNG có plaintext).
15. `__Host-client_session` cookie có `HttpOnly + Secure + SameSite=Lax + Path=/`.

## Output artifacts

- `src/lib/db/schema.js` mở rộng
- `src/lib/db/adapters/postgresAdapter.js` (optional)
- `src/lib/auth/{googleOauth,turnstile,otp,clientSession,adminSession,rbac,email}.js`
- `src/lib/audit/log.js`
- `src/lib/rateLimit/index.js`
- `src/app/api/auth/register/email/route.js`
- `src/app/api/auth/register/google/route.js`
- `src/app/api/auth/verify-registration/route.js`
- `src/app/api/auth/login/email/route.js`
- `src/app/api/auth/verify-login/route.js`
- `src/app/api/auth/resend-otp/route.js`
- `src/app/api/auth/forgot-password/route.js`
- `src/proxy.js` cập nhật
- `.env.example` cập nhật (các biến Turnstile/Google/SMTP/Encryption)
- Tests: `tests/auth/*.test.js` (vitest)

## Backward compat

- `auth_token` cookie + `/api/auth/login` route hiện tại **giữ nguyên** để không break dashboard cũ.
- Khi user chưa có trong `users` table (vẫn dùng `password` setting cũ), middleware cho phép access `/dashboard` như trước. Phase 4 sẽ migrate admin user vào `users` table với `role='ADMIN'`.
- `open-sse` core routing KHÔNG bị động vào.
