# Phase 0 — Baseline & Architecture

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Pin baseline hiện tại của 9Router, chốt schema + API contract + route/port, đảm bảo KHÔNG phá vỡ phần đang chạy trước khi vào Phase 1.

## Phạm vi

**Trong scope:**
- Verify build, test, runtime hiện tại còn xanh.
- Chốt schema mở rộng cho users/sessions/otp/gatewayKeys/requestLogs (Phase 1).
- Chốt API contract cho `/api/client/*` và `/<ADMIN_API_PREFIX>/*`.
- Chốt route mapping `/`, `/login`, `/app/*`, `/dashboard/*`, `/v1/*`, `/<ADMIN_PATH_PREFIX>/*`.
- Chốt env contract: `ADMIN_PATH_PREFIX`, `ADMIN_API_PREFIX`, `TURNSTILE_*`, `GOOGLE_*`, `ENCRYPTION_KEY_*`.

**Ngoài scope:**
- Viết code Phase 1+.

## Tasks

### 0.1. Verify baseline

```bash
cd D:\VibeCoder\9router\9router
npm install
npm run build
npm run dev    # port 20128
curl http://localhost:20128/api/health
curl http://localhost:20128/v1/models
```

Check `src/lib/db/schema.js` (SQLite tables hiện tại) → đảm bảo KHÔNG có table trùng tên với các table mới (users, gatewayKeys, requestLogs, …). Nếu trùng → đổi tên.

### 0.2. Pin schema mở rộng (declarative, chưa áp dụng)

Tạo file `src/lib/db/schema.client-admin.js` khai báo các table MỚI:

```js
export const NEW_TABLES = {
  users: { columns: { id, email, username, passwordHash, role, status, emailVerifiedAt, lastLoginAt, mfaSecretEncrypted, mfaEnabled, createdAt, updatedAt } },
  authIdentities: { ... },
  sessions: { ... },
  otpChallenges: { ... },
  allowedEmailDomains: { ... },
  securityEvents: { ... },
  gatewayKeys: { ... },
  gatewayKeyModelPolicies: { ... },
  // providers, providerCredentials, encryptionKeys — bổ sung vào schema.js hiện tại nếu thiếu
  requestLogs: { ... },
  requestExchanges: { ... },
  requestAttempts: { ... },
  toolCallLogs: { ... },
  requestAttachments: { ... },
  usageDaily: { ... },
  generationBatches: { ... },
  generationJobs: { ... },
  workers: { ... },
  auditLogs: { ... },
};
```

Đăng ký trong `src/lib/db/index.js` để `syncSchemaFromTables()` tự tạo khi Next boot.

### 0.3. Env contract (thêm vào `.env.example`)

```env
# Admin private path (random 32-char trong production)
ADMIN_PATH_PREFIX=_dev_ops_change_me
ADMIN_API_PREFIX=_dev_internal_change_me

# Cloudflare Turnstile
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
TURNSTILE_DEV_BYPASS=true      # set false trong prod

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:20128/api/auth/google/callback

# Email (OTP)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM="9Router <no-reply@router.example.com>"

# AES-256-GCM (32 bytes base64)
ENCRYPTION_KEY=
ENCRYPTION_KEY_VERSION=1

# Optional Postgres + Redis (default vẫn SQLite + in-memory)
DATABASE_URL=
REDIS_URL=

# Retention (days)
RETENTION_REQUEST_METADATA_DAYS=180
RETENTION_REQUEST_BODY_DAYS=30
RETENTION_ERROR_DAYS=90
RETENTION_AUDIT_DAYS=365
```

### 0.4. Route mapping

Cập nhật `src/proxy.js` (hoặc `dashboardGuard.js`) whitelist các path mới:

```js
const PUBLIC_PREFIXES = [
  "/api/health", "/api/init", "/api/locale",
  "/api/auth/login", "/api/auth/logout", "/api/auth/status",
  "/api/auth/register/email", "/api/auth/register/google",
  "/api/auth/verify-registration", "/api/auth/verify-login",
  "/api/auth/resend-otp", "/api/auth/forgot-password",
  "/api/version", "/api/settings/require-login",
];

const PUBLIC_CLIENT_WEB_PREFIXES = ["/", "/login", "/register", "/verify-email", "/verify-login", "/forgot-password", "/privacy", "/terms"];
const CLIENT_PORTAL_PREFIXES = ["/app"];
const ADMIN_WEB_PREFIXES = ["/dashboard", process.env.ADMIN_PATH_PREFIX];
const ADMIN_API_PREFIXES = [process.env.ADMIN_API_PREFIX];
const GATEWAY_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex"];
```

### 0.5. Cookie naming (chuẩn bị, chưa áp dụng)

- Client: `__Host-client_session` (HttpOnly, Secure, SameSite=Lax, Path=`/app`).
- Admin: `__Secure-admin_session` (HttpOnly, Secure, SameSite=Strict, Path=`/`).
- Backward compat: giữ `auth_token` cho `/api/keys`, `/api/providers`, … hiện tại (đánh dấu deprecated).

## Acceptance criteria

1. `npm run build` exit 0.
2. `npm run dev` chạy port 20128, `/api/health` trả `{ok:true}`.
3. `curl /v1/models` trả model list như cũ (không regress).
4. `.env.example` có đủ các biến mới.
5. `plans/9router-upgrade.md` đã có link tới `phase-00..08-*.md`.
6. `src/lib/db/schema.client-admin.js` tồn tại nhưng chưa được import (chỉ là declaration).

## Output artifacts

- `plans/9router-upgrade.md` ✅
- `plans/phase-00-baseline.md` ✅ (file này)
- `src/lib/db/schema.client-admin.js` (sau khi chốt schema, có thể tạo skeleton Phase 1)
- `.env.example` cập nhật (Phase 0 chỉ document, Phase 1 mới apply)
