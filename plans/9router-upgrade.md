# 9Router Upgrade Plan — AI Gateway Platform

_Last updated: 2026-06-20_
_Owner: VibeCoder_
_Status: design-only (no code yet)_

> Bản kế hoạch này nâng cấp 9Router (hiện là local OpenAI-compatible gateway + dashboard) thành một nền tảng AI Gateway có **Client Portal**, **Admin Portal**, hệ thống auth (Google OAuth + Email/OTP), API key `sk-…`, Quick Generate / Start Generation, full request logging và một hostname duy nhất. Mỗi phase trong `phase-XX-*.md` được thiết kế để triển khai độc lập với acceptance criteria rõ ràng.

---

## 0. Codebase context (scout summary)

- **Stack hiện tại**: Next.js 16.1 (App Router, standalone output), React 19, Node.js runtime, port `20128`.
- **DB**: SQLite qua abstraction `src/lib/db/` (better-sqlite3 / sql.js / node:sqlite / bun:sqlite); file `db.json` qua `src/lib/localDb.js` shim; schema khai báo trong `src/lib/db/schema.js`.
- **Auth**: single-tenant password + JWT cookie (`auth_token`) qua `src/lib/auth/dashboardSession.js`; có sẵn OIDC (`src/lib/auth/oidc.js`); API key dạng `sk-{machineId}-{keyId}-{crc8}` trong `src/shared/utils/apiKey.js`.
- **Routing core**: `open-sse/handlers/chatCore.js`, `src/sse/handlers/chat.js` (combo, account fallback, streaming, translation).
- **Compatibility APIs**: `src/app/api/v1/{chat,messages,responses,models}/route.js` + rewrites `/v1/*` → `/api/v1/*` trong `next.config.mjs`.
- **Dashboard**: `src/app/(dashboard)/dashboard/*` với các trang endpoint, providers, proxy-pools, combos, usage, skills, translator, mitm, cli-tools…
- **Login**: `src/app/login/page.js`, callback `src/app/callback/page.js`, routes `src/app/api/auth/*`.
- **Data dir**: `${DATA_DIR}` (default `~/.9router`).
- **Persistence chính**: `db.json` (settings, providers, aliases, combos, apiKeys, pricing) + `usage.json` + `log.txt` + `usageHistory` SQLite + `requestDetails` SQLite.
- **Auth secret**: `JWT_SECRET` (file fallback `DATA_DIR/jwt-secret`); API key HMAC: `API_KEY_SECRET`.

Plan này được thiết kế để **không break** những phần trên. SQLite được giữ làm default dev; PostgreSQL + Prisma/Drizzle chỉ kích hoạt khi `DATABASE_URL=postgres://…`. Client portal + admin portal dùng **route group riêng** trong cùng Next.js app (bundle riêng qua `dynamic = 'force-dynamic'` + middleware guard).

---

## 1. Tổng quan dự án

Nâng cấp thành AI Gateway platform có:

- **Client Portal** cho người dùng cuối.
- **Admin Portal** cho quản trị viên.
- **API Gateway** tương thích OpenAI và các format hiện có (`/v1/*`).
- **Account system**: Google OAuth, Email+Password, OTP email, Cloudflare Turnstile.
- **API Key** dạng `sk-xxxxxxxx` (giữ format hiện tại `sk-{machineId}-{keyId}-{crc8}` cho internal; thêm format hash-only cho client).
- **Quick Generate + Start Generation** (logic mới, không có sẵn).
- **Full request logging** với encryption (AES-256-GCM).
- **Một hostname duy nhất**, phân quyền client/admin hoàn toàn độc lập.

---

## 2. Mục tiêu chính

### 2.1. Client Portal — người dùng có thể

- Đăng ký Google, hoặc Email + Password + OTP.
- Tạo / quản lý / thu hồi API key `sk-...`.
- Chọn model được admin cho phép khi tạo key.
- Xem usage tổng hợp.
- Xem activity (chỉ thời gian + public model).
- Test model qua Playground.
- Đọc API docs.

### 2.2. Client Portal — KHÔNG được xem

- Prompt / response trong lịch sử, raw request/response, provider, upstream API key, credential pool, model nội bộ sau routing, retry/fallback, routing trace, error body từ provider, request người khác, Quick Generate / Start Generation, Admin Portal.

### 2.3. Admin Portal — admin có thể

- Quản lý user, API key (masked), provider, upstream credential, model/alias/combo/routing.
- Xem toàn bộ request, prompt, upstream request, raw model response, final client response, từng retry/fallback.
- Xem usage, token, latency, error.
- Quản lý Quick Generate, Start Generation, worker, generation jobs.
- Quản lý email domain allowlist, OTP policy, Turnstile.
- Xem audit log.

---

## 3. Nguyên tắc kiến trúc

### 3.1. Phân biệt 3 loại key

| Loại | Mục đích | Lưu trữ |
|---|---|---|
| Client API Key `sk-...` | User gọi gateway | Chỉ `keyPrefix`, `keyHash`, `lastFour` (KHÔNG plaintext) |
| Provider Credential | Gateway gọi upstream | AES-256-GCM encrypted, KHÔNG trả qua list API |
| Generation Job secret | Admin tạo credential mới | AES-256-GCM encrypted config |

### 3.2. Nguyên tắc phân quyền

- Client session cookie: `__Host-client_session` (HttpOnly, Secure, SameSite=Lax).
- Admin session cookie: `__Secure-admin_session` (HttpOnly, Secure, SameSite=Strict).
- Không share session, không share bundle, không share component.
- Admin API prefix được randomize theo env (`ADMIN_PATH_PREFIX`, `ADMIN_API_PREFIX`).

---

## 4. Một hostname duy nhất

```
https://router.example.com
```

### 4.1. Public routes
```
/                  Landing page
/login             Đăng nhập
/register          Đăng ký
/verify-email      OTP đăng ký
/verify-login      OTP đăng nhập
/forgot-password   Quên mật khẩu
/privacy           Chính sách bảo mật
/terms             Điều khoản
```

### 4.2. Client routes
```
/app
/app/api-keys
/app/models
/app/activity
/app/playground
/app/usage
/app/api-docs
/app/account
```

### 4.3. Gateway routes (giữ nguyên Next.js rewrites hiện tại)
```
/v1/models
/v1/chat/completions
/v1/responses
/v1/messages
/v1/embeddings
/v1/images/generations
/v1/audio/speech
/v1/audio/transcriptions
```

### 4.4. Admin routes (private path)
```
/<ADMIN_PATH_PREFIX>/*        # Admin web (random secret)
/<ADMIN_API_PREFIX>/*         # Admin API (random secret, khác prefix)
```

Env:
```env
ADMIN_PATH_PREFIX=_ops_<32-char-random>
ADMIN_API_PREFIX=_internal_<32-char-random>
```

Default dev fallback (KHÔNG dùng production):
```
ADMIN_PATH_PREFIX=_dev_ops_change_me
ADMIN_API_PREFIX=_dev_internal_change_me
```

> **Lưu ý 9Router hiện tại**: dashboard nằm ở `/dashboard/*`. Plan này giữ `/dashboard/*` cho admin (route guard đổi sang check session admin thay vì dashboard password), đồng thời thêm `/app/*` cho client.

---

## 5. Kiến trúc hệ thống

```text
Internet
   │
   ▼
Cloudflare (CDN + WAF + Turnstile + Access cho admin prefix)
   │
   ▼
Reverse proxy (Nginx/Caddy/Custom-server)
   │
   ├── /, /login, /register, /verify-*, /app/*            → Client Web (Next.js route group)
   ├── /v1/*                                                → 9Router Gateway (Next.js route handler hiện tại)
   ├── /dashboard/*                                         → Admin Web (route group, cookie admin)
   └── /<ADMIN_PATH_PREFIX>/*, /<ADMIN_API_PREFIX>/*        → Admin Web + Admin API
                              │
                              ├── SQLite (dev) / PostgreSQL (prod) qua @9router/database
                              ├── Redis (queue, rate-limit) — optional ở MVP, fallback in-memory
                              └── Generation Worker (in-process MVP, tách service Phase 6)
```

### 5.1. Cấu trúc code đề xuất (giữ tương thích 9Router hiện tại)

```
src/
├── app/
│   ├── (client)/              # Client portal route group (NEW)
│   │   ├── app/...
│   │   ├── register/page.js
│   │   ├── login/page.js
│   │   ├── verify-email/page.js
│   │   ├── verify-login/page.js
│   │   └── forgot-password/page.js
│   ├── (dashboard)/dashboard/...   # Admin web (EXISTING, đổi guard)
│   ├── api/
│   │   ├── client/...        # Client API (NEW)
│   │   ├── _admin/...        # Admin API (NEW, mounted ở /<ADMIN_API_PREFIX>)
│   │   ├── auth/...          # Mở rộng: register/email, register/google, verify-*, resend-otp
│   │   ├── v1/...            # Gateway (EXISTING, giữ nguyên)
│   │   └── keys/...          # Internal admin key management (EXISTING, chuyển dần sang _admin)
│   └── page.js
├── lib/
│   ├── db/                   # (EXISTING) — mở rộng schema, thêm PostgreSQL adapter
│   ├── auth/                 # (EXISTING + NEW) — googleOauth, otp, turnstile
│   ├── client/               # (NEW) clientAuth, clientSession, clientKey, clientQuota
│   ├── admin/                # (NEW) adminAuth, adminSession, rbac, mfa
│   ├── crypto/               # (NEW) aes256gcm, keyRotation
│   ├── logging/              # (NEW) requestLogger (mở rộng open-sse/utils/requestLogger.js)
│   ├── generation/           # (NEW) quickGen, browserWorkerAdapter
│   └── rateLimit/            # (NEW) redis fallback in-memory
├── shared/                   # (EXISTING)
├── sse/                      # (EXISTING)
└── proxy.js                  # (EXISTING) — mở rộng guard cho client/admin/public
```

> **Bundle isolation**: Dùng `dynamic = 'force-dynamic'` + `next.config.mjs` `modularizeImports` để tách component admin/client. Thêm ESLint rule `no-restricted-imports` chặn import `@/app/(dashboard)` từ `(client)`.

---

## 6. Port hệ thống

| Thành phần | Port | Public | Ghi chú |
|---|---|---|---|
| Reverse Proxy (custom-server.js) | 80, 443 | Có | Giữ `PORT=20128` làm port nội bộ |
| 9Router Gateway | 20128 | Không | EXISTING |
| Admin Web/API (Next.js) | 20128 (cùng process) | Không | EXISTING, route guard mới |
| Client Web (Next.js) | 20128 (cùng process) | Không | NEW, route guard mới |
| Generation Worker (Phase 6) | in-process MVP | Không | Có thể tách port 3010 sau |
| PostgreSQL | 5432 | Không | Optional (chỉ khi `DATABASE_URL` set) |
| Redis | 6379 | Không | Optional (chỉ khi `REDIS_URL` set); fallback in-memory |

> 9Router vẫn chạy **single-process**. Tách service thật chỉ làm khi Phase 6 (Generation Worker) cần scale browser workers.

---

## 7. Authentication của Client

Hỗ trợ:

```
Continue with Google   (Cloudflare Turnstile → Google OAuth → check email_verified → domain allowlist → client session)
Email + Password       (Turnstile → password verify → gửi OTP email → verify OTP → client session)
```

Mọi endpoint auth phải xác minh **Turnstile** phía server với Fail-Closed mode ở production.

---

## 8. Đăng ký bằng Google

Luồng:
```
Turnstile (action=register_google)
  → Google OAuth (scope=openid email profile)
    → email_verified = true
      → domain trong allowlist
        → user ACTIVE
          → client session cookie
```

State + nonce validate. Admin có thể bật "Require OTP after Google Login" (mặc định OFF).

---

## 9. Đăng ký bằng Email

### 9.1. Domain

Mặc định: `gmail.com`, `yahoo.com`. Admin thêm/xóa trong Admin Portal.

### 9.2. Registration mode
`ALLOWLIST` (MVP) | `BLOCKLIST` | `DISABLED`.

### 9.3. Kiểm tra domain

Dùng exact compare sau normalize:
```js
const domain = email.toLowerCase().split("@")[1];
const allowed = (await getAllowedDomains()).some(d => d.domain === domain);
```
KHÔNG dùng `email.includes("gmail.com")`.

### 9.4. Luồng đăng ký

```
Email + Password + Turnstile
  → check domain allowlist
    → check rate-limit (3/h, 5/day per IP)
      → bcrypt hash
        → User PENDING_VERIFICATION
          → gửi OTP (6 số, 5 phút)
            → verify OTP
              → User ACTIVE
                → client session
```

---

## 10. Đăng nhập bằng Email

Bắt buộc 2-step:
```
Email + Password + Turnstile
  → verify password
    → tạo Login Challenge (OtpChallenge, purpose=EMAIL_LOGIN)
      → gửi OTP
        → verify OTP
          → client session (cookie __Host-client_session)
```

Chưa verify OTP:
- Không vào `/app/*`.
- Không tạo API key.
- Không gọi `/api/client/*`.

---

## 11. OTP Policy

Default:
```
Length:            6 digits
TTL:               5 min
Max attempts:      5
Resend cooldown:   60s
Max send/email/h:  5
```

Yêu cầu:
- Lưu `otpHash` (SHA-256 + salt), KHÔNG plaintext.
- OTP chỉ dùng một lần (`consumedAt`).
- Tạo OTP mới → invalidate OTP cũ cùng `purpose`.
- Không log OTP. Không trả OTP qua API.

Purpose enum:
```
EMAIL_REGISTRATION, EMAIL_LOGIN, PASSWORD_RESET, CHANGE_EMAIL, SENSITIVE_ACTION
```

---

## 12. Cloudflare Turnstile

Áp dụng tại:
- `register_google`
- `register_email`
- `login_email`
- `resend_otp`
- `forgot_password`
- `create_api_key` (khi admin bật "Required Turnstile")
- Sau N lần login fail

Production: Fail-Closed. Backend xác minh token qua `https://challenges.cloudflare.com/turnstile/v0/siteverify`.

Dev: optional, set `TURNSTILE_DEV_BYPASS=true` cho local testing.

---

## 13. User status

```
PENDING_VERIFICATION   chưa OTP, không tạo key
ACTIVE                 bình thường
SUSPENDED              API key bị revoke, có thể login hoặc không
BANNED                 cấm hoàn toàn
DELETED                soft delete, scheduled purge
```

---

## 14. Role

```
SUPER_ADMIN   toàn quyền, quản lý admin khác, secret policy
ADMIN         quản lý client, model, provider, request logs, generation
SUPPORT       xem metadata, optional xem content
AUDITOR       read-only
CLIENT        chỉ client portal
```

Schema: `users.role` (string). MVP chỉ cần phân biệt `ADMIN` vs `CLIENT`. Multi-role admin thêm sau.

---

## 15. Bảo vệ Admin Portal

Multi-layer:
```
Cloudflare Access (email allowlist)          # optional nhưng khuyến nghị
+ WAF rule rate-limit path admin             # trong Caddy/Nginx
+ Private path (ADMIN_PATH_PREFIX random)    # obscurity, không phải auth
+ Admin login (password + TOTP MFA)          # bắt buộc từ Phase 7
+ Server-side RBAC                           # bắt buộc từ Phase 1
+ Short session (8h default) + re-auth cho sensitive
+ 404 thay vì 403 khi không hợp lệ (chống dò)
```

Cookies:
- Client: `__Host-client_session`
- Admin: `__Secure-admin_session`

> **Hiện trạng 9Router**: chỉ có 1 cookie `auth_token`. Plan này thêm 2 cookie mới và giữ `auth_token` cho backward compat (đánh dấu deprecated, dùng cho route cũ `/api/keys`, `/api/providers`).

---

## 16. Client Portal — sidebar

```
Overview
API Keys
Models
Request Activity
Playground
Usage
API Docs
Account
```

---

## 17. Client Dashboard

Hiển thị:
- Tổng request, input/output token, quota đã dùng / còn lại, usage theo ngày, theo model, success rate.

KHÔNG hiển thị:
- Prompt / response / provider / credential / routing trace / error body.

---

## 18. Client Request Activity

Mỗi item chỉ gồm:
```json
{ "createdAt": "...", "model": "public-model-id" }
```

Client Activity API: `GET /api/client/activity?cursor=...&limit=50` → chỉ trả `items: [{createdAt, model}]`.

---

## 19. Client API Keys

Format:
```
sk-<base64url 32-byte random>
```

Điều kiện tạo:
```
User ACTIVE + emailVerifiedAt != null + OTP login complete + session valid
+ chưa vượt maxKeysPerUser (default 5) + Turnstile nếu required
```

DB chỉ lưu:
```
keyPrefix   sk-AbCd   (4-6 ký tự đầu)
keyHash     sha256(key + keySalt) hoặc argon2
lastFour    xQ91
```

Hiển thị plaintext 1 lần khi tạo. Rotate = tạo mới + revoke cũ.

> **Lưu ý 9Router hiện tại**: `src/shared/utils/apiKey.js` dùng format `sk-{machineId}-{keyId}-{crc8}` cho internal dashboard API key. Plan này giữ format đó cho **internal admin/dashboard key** (dùng để gọi `/v1/*` từ chính 9Router dashboard hoặc CLI local) và thêm format **client-facing key** riêng (`sk-<base64url random>` chỉ verify bằng `keyHash`). Hai format tách biệt, dùng cột khác nhau trong `gatewayKeys`.

---

## 20. Client Models

Client được xem: display name, capability, status (online/maintenance).
Client KHÔNG xem: provider gốc, upstream model id, pricing nội bộ, credential pool, routing weight, fallback chain.

---

## 21. Client Playground

- Chọn API key, chọn model, nhập system + user prompt, bật/tắt streaming.
- Response hiển thị ngay khi chạy.
- Sau khi rời trang, **không** đọc lại được response trong lịch sử.

---

## 22. Admin Portal — sidebar

```
Overview
Users
API Keys
Providers
Credentials
Models
Combos
Generation
Request Logs
Usage & Costs
Workers
Authentication
Audit Logs
System Settings
```

---

## 23. Admin Dashboard

Tổng user / active / API key / request / token / error rate / P50-P95-P99 latency / top model / top user / provider health / credential health / worker status / queue depth / generation success rate.

---

## 24. Admin Request Logs

Mỗi request 4 lớp:

1. **Client Request** — endpoint, method, headers (redacted), model public, system prompt, user prompt, conversation history, tool definitions, image/file input, temperature, max_tokens, stream, IP, UA, ts.
2. **Upstream Request** — provider, credential id, upstream endpoint, upstream model id, normalized body, system prompt đã inject, parameters đã đổi, tool schema sau convert.
3. **Model Response** — raw JSON, text output, reasoning, tool calls, tool args, usage, stop reason, provider request id, HTTP status, rate-limit headers, error body, upstream latency.
4. **Client Response** — final JSON, final text, model public, finish reason, usage, reconstructed stream, response headers (filtered).

---

## 25. Admin Request Detail UI

Tabs: Overview · Client Request · Upstream Request · Model Response · Client Response · Routing Trace · Attempts · Tokens & Timing · Errors · Security.

---

## 26. Retry / Fallback

Mỗi attempt lưu riêng: provider, credential id, model, status, latency, wasSelected. Admin xem được; client không biết.

---

## 27. Streaming Logging

```
client request
  → log request
    → call provider
      → receive chunk
        → convert chunk
          → stream chunk to client (đồng thời append vào reconstructed response)
            → end stream
              → save reconstructed model response (AES-256-GCM)
                → save reconstructed client response
```

Mặc định: lưu first/last chunk ts, chunk count, reconstructed body. Không lưu từng chunk.

Cờ debug `storeRawSseChunks` (admin bật theo user/key/model/window).

---

## 28. Quick Generate & Start Generation

Chỉ admin.

**Quick Generate**: tạo credential qua HTTP/API trực tiếp (gọi provider OAuth/device-code API).
**Start Generation**: tạo credential qua browser worker (Playwright/Puppeteer) chạy tách process.

Job states: `QUEUED · RUNNING · WAITING_EMAIL · WAITING_OTP · WAITING_MANUAL_ACTION · RETRYING · SUCCEEDED · PARTIALLY_SUCCEEDED · FAILED · CANCELLED`.

MVP: in-process queue (in-memory + persist batch/job rows). Phase 6 chuyển sang Redis queue nếu cần.

---

## 29. Provider & Credential

Admin quản lý:
- Provider name, base URL, API format, auth type, custom headers, timeout, priority, weight, concurrency, proxy outbound, health, budget, quota, cooldown, enable/disable.

Credential:
- AES-256-GCM encrypted trong DB.
- KHÔNG trả plaintext qua list API.
- Health check + failure counter + cooldown + lastUsed + quotaResetAt.

---

## 30. Model Management

Admin: enable/disable, display name, public alias, upstream model id, capability, context window, model per-user / per-key, combo, fallback chain, round-robin, maintenance, priority/weight.

Client chỉ thấy `publicModelId` + display name.

---

## 31. Database Design (SQLite + Postgres compatible)

> Schema khai báo trong `src/lib/db/schema.js` (hiện đang là SQLite). Plan này mở rộng thêm tables; Prisma/Drizzle schema là optional layer Phase 7.

### User / Auth
```
users(id, email, username, passwordHash, role, status,
      emailVerifiedAt, lastLoginAt, mfaSecretEncrypted,
      mfaEnabled, createdAt, updatedAt)

authIdentities(id, userId, provider, providerAccountId,
               providerEmail, emailVerified, createdAt, lastLoginAt)

sessions(id, userId, sessionType, tokenHash, ipAddress,
         userAgent, expiresAt, revokedAt, createdAt)
  -- sessionType: 'client' | 'admin'

otpChallenges(id, userId, email, purpose, otpHash,
              attempts, maxAttempts, expiresAt, consumedAt,
              createdIp, createdAt)

allowedEmailDomains(id, domain, isEnabled, createdBy, createdAt, updatedAt)

securityEvents(id, userId, eventType, riskScore,
               ipAddress, userAgent, ephemeralId, metadata, createdAt)
```

### Gateway keys (client-facing)
```
gatewayKeys(id, userId, name, keyPrefix, keyHash, lastFour,
            status, expiresAt, lastUsedAt, lastUsedIp,
            requestsPerMinute, tokensPerDay, tokensPerMonth,
            createdAt, revokedAt)
  -- keyHash = argon2id(key, userSalt) — KHÔNG lưu plaintext
  -- KHÁC với apiKeys (internal) hiện có của 9Router

gatewayKeyModelPolicies(gatewayKeyId, modelId, isAllowed, maxTokens)
```

> **Internal apiKeys** (`src/lib/db/schema.js` → `apiKeys`) được GIỮ NGUYÊN cho dashboard/CLI local key. Thêm `gatewayKeys` riêng cho client-facing key.

### Provider / Credential
```
providers(id, code, displayName, format, baseUrl, authType,
          status, priority, weight, timeoutMs, createdAt, updatedAt)

providerCredentials(id, providerId, name, credentialEncrypted,
                    keyVersion, status, priority, quota, quotaResetAt,
                    lastUsedAt, lastError, consecutiveFailures,
                    cooldownUntil, createdAt, updatedAt)

encryptionKeys(id, version, status, createdAt, retiredAt)  -- key rotation
```

### Model / Combo
```
models(id, providerId, publicModelId, upstreamModelId,
       displayName, capabilities, contextWindow, status,
       createdAt, updatedAt)

combos(id, name, strategy, status, createdAt, updatedAt)

comboModels(comboId, modelId, position, weight)
```

### Request Logging
```
requestLogs(id, requestId, userId, gatewayKeyId,
            endpoint, method, publicModel, resolvedModel,
            statusCode, isStreaming, finishReason,
            inputTokens, outputTokens, totalTokens,
            latencyMs, timeToFirstTokenMs,
            retryCount, fallbackCount, selectedAttemptId,
            clientIp, country, userAgent,
            errorCode, errorMessage,
            startedAt, completedAt, createdAt)

requestExchanges(id, requestLogId,
                 clientRequestHeadersEncrypted,
                 clientRequestBodyEncrypted,
                 normalizedRequestBodyEncrypted,
                 finalClientResponseHeadersEncrypted,
                 finalClientResponseBodyEncrypted,
                 systemPromptTextEncrypted,
                 userPromptTextEncrypted,
                 assistantResponseTextEncrypted,
                 reasoningTextEncrypted,
                 clientRequestSizeBytes,
                 clientResponseSizeBytes,
                 createdAt, expiresAt)

requestAttempts(id, requestLogId, attemptNumber,
                providerId, providerCredentialId, upstreamModel,
                upstreamEndpoint,
                upstreamRequestHeadersEncrypted,
                upstreamRequestBodyEncrypted,
                upstreamResponseHeadersEncrypted,
                upstreamResponseBodyEncrypted,
                statusCode, errorCode, errorMessage,
                inputTokens, outputTokens, latencyMs,
                timeToFirstTokenMs, chunkCount, wasSelected,
                startedAt, completedAt)

toolCallLogs(id, requestLogId, requestAttemptId, toolCallId,
             toolName, toolArgumentsEncrypted, toolResultEncrypted,
             createdAt)

requestAttachments(id, requestLogId, type, mimeType,
                   sizeBytes, storageKey, sha256,
                   createdAt, expiresAt)

usageDaily(date, userId, gatewayKeyId, publicModel,
           requestCount, successCount, errorCount,
           inputTokens, outputTokens, estimatedCost)
```

### Generation
```
generationBatches(id, mode, providerId, requestedCount,
                  successCount, failedCount, status, createdBy,
                  configEncrypted, startedAt, completedAt, createdAt)

generationJobs(id, batchId, status, currentStep, progress,
               workerId, attempt, email, username,
               resultCredentialId, errorCode, errorMessage,
               startedAt, completedAt)

workers(id, name, status, version, lastHeartbeatAt,
        activeJobs, capacity, createdAt, updatedAt)
```

### Audit
```
auditLogs(id, actorUserId, action, entityType, entityId,
          beforeData, afterData, ipAddress, userAgent, createdAt)
```

---

## 32. Secret Redaction

Trước khi lưu log, redact:
```
Authorization, Proxy-Authorization, X-API-Key, Cookie, Set-Cookie
OAuth access/refresh tokens, provider API keys, DB creds, Cloudflare token,
internal worker token
```

Client API key: KHÔNG plaintext. Chỉ `gatewayKeyId + name + prefix + lastFour`.

---

## 33. Encryption

```
AES-256-GCM
Lưu: encryptedPayload, iv, authTag, keyVersion
Key: lưu trong env / secret manager (KHÔNG trong DB)
Rotation: encryptionKeys.version
Dev key ≠ Prod key
```

Library: Node.js `crypto.createCipheriv('aes-256-gcm', ...)`.

---

## 34. Request Lifecycle

```
1. Client gửi request với sk- key
2. Gateway hash + tìm gatewayKeys
3. Check key status, user status, expiration
4. Check rate-limit, quota, model permission
5. Tạo requestLogs (status=running)
6. Lưu client request (encrypted)
7. Resolve public model → upstream model + provider
8. Tạo requestAttempts
9. Lưu upstream request (encrypted)
10. Gọi provider (open-sse chatCore, EXISTING)
11. Nhận model response → lưu raw (encrypted)
12. Normalize + stream trả client
13. Lưu final client response (encrypted)
14. Cập nhật usage, quota
15. Complete requestLogs
```

> **Quan trọng**: step 10-13 dùng **chính** `open-sse/handlers/chatCore.js` hiện tại. Logging là middleware chèn vào giữa, không sửa core routing. `requestDetails` table hiện tại (`src/lib/db/repos/requestDetailsRepo.js`) được MỞ RỘNG thành `requestExchanges` + `requestAttempts`.

---

## 35. Client API (NEW routes)

### Auth
```
POST /api/auth/register/email
POST /api/auth/register/google
POST /api/auth/verify-registration
POST /api/auth/login/email
POST /api/auth/verify-login
POST /api/auth/resend-otp
POST /api/auth/logout
POST /api/auth/forgot-password
```

### Client
```
GET    /api/client/dashboard
GET    /api/client/models
GET    /api/client/api-keys
POST   /api/client/api-keys
PATCH  /api/client/api-keys/:id
DELETE /api/client/api-keys/:id
POST   /api/client/api-keys/:id/rotate
GET    /api/client/usage/summary
GET    /api/client/usage/daily
GET    /api/client/usage/models
GET    /api/client/activity            ← chỉ trả {createdAt, model}
POST   /api/client/playground
```

---

## 36. Admin API

```
GET    /<ADMIN_API_PREFIX>/dashboard
GET    /<ADMIN_API_PREFIX>/users
POST   /<ADMIN_API_PREFIX>/users
PATCH  /<ADMIN_API_PREFIX>/users/:id
POST   /<ADMIN_API_PREFIX>/users/:id/suspend
POST   /<ADMIN_API_PREFIX>/users/:id/revoke-keys
GET    /<ADMIN_API_PREFIX>/api-keys
PATCH  /<ADMIN_API_PREFIX>/api-keys/:id
POST   /<ADMIN_API_PREFIX>/api-keys/:id/revoke
GET    /<ADMIN_API_PREFIX>/providers
POST   /<ADMIN_API_PREFIX>/providers
PATCH  /<ADMIN_API_PREFIX>/providers/:id
POST   /<ADMIN_API_PREFIX>/providers/:id/test
GET    /<ADMIN_API_PREFIX>/credentials
POST   /<ADMIN_API_PREFIX>/credentials
PATCH  /<ADMIN_API_PREFIX>/credentials/:id
POST   /<ADMIN_API_PREFIX>/credentials/:id/test
GET    /<ADMIN_API_PREFIX>/models
POST   /<ADMIN_API_PREFIX>/models
PATCH  /<ADMIN_API_PREFIX>/models/:id
GET    /<ADMIN_API_PREFIX>/requests
GET    /<ADMIN_API_PREFIX>/requests/:requestId
GET    /<ADMIN_API_PREFIX>/requests/:requestId/attempts
POST   /<ADMIN_API_PREFIX>/requests/:requestId/replay
POST   /<ADMIN_API_PREFIX>/generation/quick
POST   /<ADMIN_API_PREFIX>/generation/browser
GET    /<ADMIN_API_PREFIX>/generation/batches
GET    /<ADMIN_API_PREFIX>/generation/batches/:id
POST   /<ADMIN_API_PREFIX>/generation/batches/:id/cancel
POST   /<ADMIN_API_PREFIX>/generation/jobs/:id/retry
GET    /<ADMIN_API_PREFIX>/workers
GET    /<ADMIN_API_PREFIX>/audit-logs
GET    /<ADMIN_API_PREFIX>/settings/authentication
PATCH  /<ADMIN_API_PREFIX>/settings/authentication
```

> **9Router hiện tại** có sẵn `/api/keys`, `/api/providers`, … cho dashboard. Plan này mount các route admin mới ở `/<ADMIN_API_PREFIX>/*` nhưng GIỮ BACKWARD COMPAT: `/api/keys` cũ vẫn hoạt động cho internal dashboard, chỉ redirect dần sang prefix mới khi admin client UI migrate xong.

---

## 37. Authentication Settings (admin config)

Registration, OTP, Turnstile, API Keys (max keys, default RPM, default token quota, required Turnstile, required re-auth), Logging (store client/upstream/model/client response, store reasoning, store tool calls, store attachments, retention, raw SSE debug).

---

## 38. Rate Limit

| Endpoint | Limit |
|---|---|
| Register | 3/h/IP, 5/day/IP |
| OTP send | 1/60s/email, 5/h/email, 10/day/email |
| Login fail | 5/15min/email, 20/15min/IP |
| API key create | max 5/user, 1/10s, 10/day/user |

Storage: in-memory MVP + Redis optional Phase 7.

---

## 39. Retention

Default:
```
requestLogs metadata   180d
requestExchanges body  30d
requestLogs error      90d
auditLogs              365d
usageDaily             forever (small)
```

Admin chọn: 7d / 30d / 90d / 180d / 365d / no-auto-delete.

> 9Router hiện không có retention — thêm cron job Phase 5.

---

## 40. Images / Files

Text trong SQLite/Postgres. Binary lớn → filesystem `${DATA_DIR}/attachments/<sha256>` (MVP) hoặc S3 (Phase 7+).

---

## 41. Privacy & Terms

Trang đăng ký ghi rõ: requests (prompt, input, response, technical metadata) có thể được ghi lại để vận hành, debug, bảo mật, chống lạm dụng. User phải đồng ý Terms + Privacy + Logging policy.

---

## 42. Roadmap triển khai (file con)

| Phase | File | Nội dung | Effort |
|---|---|---|---|
| 0 | [phase-00-baseline.md](phase-00-baseline.md) | Fork, pin tag, test hiện tại, chốt DB schema, API contract | 1–2d |
| 1 | [phase-01-db-auth.md](phase-01-db-auth.md) | DB mở rộng + Postgres optional, Client auth (Google + Email+OTP), Turnstile, RBAC, Audit log, Client/Admin session riêng | 5–7d |
| 2 | [phase-02-gateway-keys.md](phase-02-gateway-keys.md) | Sinh key `sk-`, hash key, model permission, quota, rate-limit, suspend/revoke, integrate vào `/v1/*` | 4–6d |
| 3 | [phase-03-client-portal.md](phase-03-client-portal.md) | Dashboard, API Keys, Models, Activity (chỉ time+model), Usage, Playground, API Docs, Account | 4–6d |
| 4 | [phase-04-admin-portal.md](phase-04-admin-portal.md) | Users, API Keys, Providers, Credentials, Models, Combos, Auth settings, Audit, System settings | 5–8d |
| 5 | [phase-05-request-logging.md](phase-05-request-logging.md) | Client/Upstream/Model/Client response logging, streaming reconstruction, retry/fallback attempts, encryption, redaction, Admin Request Detail UI | 6–9d |
| 6 | [phase-06-generation.md](phase-06-generation.md) | In-process queue MVP, Quick Generate adapter, Browser worker adapter, heartbeat, retry/cancel, history, credential test & import | 5–8d |
| 7 | [phase-07-security-prod.md](phase-07-security-prod.md) | Cloudflare Access, admin private path, WAF, MFA/TOTP, backup, retention, metrics, alerting, Docker Compose, security review | 4–6d |
| 8 | [phase-08-test-release.md](phase-08-test-release.md) | Unit/Integration/RBAC/Streaming/Logging/Failover/Load/Migration tests, prod docs | 4–6d |

Tổng MVP (Phase 0–6): **30–45 ngày công** (6–9 tuần, 1 dev chính).
Tổng Production (Phase 0–8): **45–65 ngày công** (9–13 tuần).

---

## 43. Out of scope (MVP)

- Billing tiền thật, reseller, affiliate.
- Multi-region, Kubernetes.
- Mobile app, white-label builder, marketplace.
- Complex org/team (chỉ single-tenant mỗi 9Router instance).
- Full-text encrypted prompt search nâng cao.

---

## 44. Acceptance Criteria (tổng)

Xem chi tiết trong từng `phase-XX-*.md`. Tóm tắt:

**Auth (1–8)**: chưa login không tạo key · email ngoài allowlist fail · OTP bắt buộc cho email · Google chỉ nhận verified email · Turnstile server verify · OTP không plaintext · admin chỉnh được allowed domain.

**Client (9–20)**: tạo `sk-…` · plaintext 1 lần · DB chỉ hash · chỉ dùng model được cấp · activity chỉ time + public model · không xem prompt/response/provider/upstream/routing · không gọi admin API · Playground show response tức thì.

**Admin (21–32)**: full user · full API key masked · Client Request · system+user prompt · Upstream Request · upstream model id · raw Model Response · final Client Response · từng retry/fallback · tool calls + reasoning · usage + latency · VIEW_REQUEST_CONTENT audit logged.

**Logging (33–40)**: streaming reconstructed · encrypted · secrets redacted · gateway key không plaintext · logging error không break client · retention · file lớn tách riêng · client không có endpoint đọc full log.

**Admin Security (41–47)**: một hostname · private path · Cloudflare Access · MFA admin · client/admin session riêng · 404 thay vì 403 · admin không mở port.

**Generation (48–53)**: Quick Generate qua queue · Start Generation qua worker · progress/retry/cancel · restart app không mất job · credential test trước active · client không thấy Generation Center.

---

## 45. Final flow

```
User register → Google hoặc Email+OTP (Turnstile)
  → Login → tạo sk- key → chọn model được cấp
    → gọi /v1/* → Gateway verify key
      → log Client Request → resolve model → log Upstream Request
        → call model → log Model Response → normalize
          → trả client → log Client Response
```

**Client chỉ thấy**:
```
20/06/2026 21:42:08 → claude-sonnet
```

**Admin thấy**: user nào → key nào → prompt gì → public model → gateway convert → provider → upstream model → model response → gateway response cuối → retry/fallback nào.

---

## Phụ lục — Liên kết nhanh

- [Phase 0: Baseline & Architecture](phase-00-baseline.md)
- [Phase 1: Database & Authentication](phase-01-db-auth.md)
- [Phase 2: API Key & Gateway Authorization](phase-02-gateway-keys.md)
- [Phase 3: Client Portal](phase-03-client-portal.md)
- [Phase 4: Admin Portal](phase-04-admin-portal.md)
- [Phase 5: Full Request Logging](phase-05-request-logging.md)
- [Phase 6: Quick Generate & Start Generation](phase-06-generation.md)
- [Phase 7: Security & Production](phase-07-security-prod.md)
- [Phase 8: Testing & Release](phase-08-test-release.md)
