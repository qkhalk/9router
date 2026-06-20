# Phase 4 — Admin Portal

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Admin Portal đầy đủ: Users, API Keys, Providers, Credentials, Models, Combos, Authentication settings, Audit Logs, System Settings. Reuse dashboard UI hiện tại (`src/app/(dashboard)/dashboard/*`), mở rộng thêm pages cho phần mới. Migrate admin user vào `users` table với `role='ADMIN'`. API endpoints mount dưới `/<ADMIN_API_PREFIX>/*`.

## Phạm vi

**Trong scope:**
- `src/app/(dashboard)/dashboard/users/page.js` — list, search, filter; row actions: view, suspend, ban, reset password, revoke all keys.
- `src/app/(dashboard)/dashboard/users/[id]/page.js` — detail + activity + audit.
- `src/app/(dashboard)/dashboard/admin-api-keys/page.js` — view all client keys (masked).
- `src/app/(dashboard)/dashboard/admin-providers/page.js` — CRUD provider.
- `src/app/(dashboard)/dashboard/admin-credentials/page.js` — CRUD credential (KHÔNG show plaintext; show masked + actions test/rotate/revoke).
- `src/app/(dashboard)/dashboard/admin-models/page.js` — CRUD model + grant to user.
- `src/app/(dashboard)/dashboard/admin-combos/page.js` — combo CRUD (dùng lại UI combos hiện tại).
- `src/app/(dashboard)/dashboard/admin-auth/page.js` — auth settings: registration, OTP, Turnstile, API key defaults, logging.
- `src/app/(dashboard)/dashboard/admin-audit/page.js` — audit log viewer.
- `src/app/(dashboard)/dashboard/admin-system/page.js` — retention, encryption key rotation, raw SSE debug toggle, email template.
- API endpoints: xem Phase 4 admin API list trong plan tổng §39.
- Migration admin user: nếu `settings.password` tồn tại + chưa có user `role='ADMIN'` → tạo user admin với email=`<default>@local`, password=hash từ settings.
- `src/app/(dashboard)/dashboard/page.js` (Overview) cập nhật thêm widget mới.

**Ngoài scope:**
- Request body viewer (Phase 5).
- Quick Generate / Start Generation UI (Phase 6).
- MFA/TOTP setup UI (Phase 7).

## Tasks

### 4.1. Admin user migration

Trong `src/shared/services/initializeApp.js` (Phase 1 đã có) hoặc script riêng:

```js
export async function ensureAdminUser() {
  const settings = await getSettings();
  if (!settings.password) return; // local mode no password
  const existing = await usersRepo.findByRole('ADMIN');
  if (existing.length > 0) return;
  const adminEmail = process.env.ADMIN_DEFAULT_EMAIL || 'admin@local';
  const passwordHash = await bcrypt.hash(verifyPasswordWithSettings(settings.password), 12);
  await usersRepo.create({
    email: adminEmail,
    username: 'admin',
    passwordHash,
    role: 'ADMIN',
    status: 'ACTIVE',
    emailVerifiedAt: new Date().toISOString(),
  });
}
```

Khi admin login bằng `/api/auth/login/email` (Phase 1 mới) → set `__Secure-admin_session` cookie. Khi login bằng `auth_token` legacy → middleware chấp nhận + tự động issue `__Secure-admin_session` lần đầu.

### 4.2. Users page

`/dashboard/users`:
- Table: email, role, status, createdAt, lastLoginAt, requestCount30d, actions.
- Filter: role, status, search email.
- Detail `/dashboard/users/[id]`: tabs Profile · API Keys · Sessions · Activity · Usage · Audit.
- Actions: Suspend (set status `SUSPENDED` + revoke tất cả gatewayKeys), Ban, Reset Password (gửi OTP), Delete (soft delete).

API: `/<ADMIN_API_PREFIX>/users` (GET/POST), `/users/:id` (PATCH), `/users/:id/suspend`, `/users/:id/revoke-keys`.

### 4.3. Admin API Keys

`/dashboard/admin-api-keys`:
- Table: name, user, keyPrefix••••lastFour, status, createdAt, lastUsedAt, expiresAt, requestsPerMinute, actions.
- Filter: user, status, model.
- Actions: Revoke, Rotate.

API: `/<ADMIN_API_PREFIX>/api-keys` (GET), `/api-keys/:id` (PATCH), `/api-keys/:id/revoke`.

### 4.4. Providers

`/dashboard/admin-providers`:
- List + create + edit + test.
- Fields: code, displayName, format (`openai|claude|gemini|...`), baseUrl, authType, status, priority, weight, timeoutMs, custom headers, proxy outbound, health status.
- Existing CRUD `/api/providers` của 9Router GIỮ NGUYÊN; thêm alias mount ở `/<ADMIN_API_PREFIX>/providers/*` (gọi cùng handler).

### 4.5. Credentials

`/dashboard/admin-credentials`:
- List: provider, name, status (active/cooldown/error), quota, lastUsedAt, lastError, consecutiveFailures.
- KHÔNG hiển thị plaintext; chỉ masked prefix + status.
- Actions: Create (POST `/<ADMIN_API_PREFIX>/credentials` với plaintext từ form, server encrypt rồi lưu), Test, Rotate, Revoke, View encrypted blob (download backup, ghi audit log).

API: `/<ADMIN_API_PREFIX>/credentials` (GET trả masked, POST nhận plaintext), `/credentials/:id` (PATCH), `/credentials/:id/test`.

Encryption: dùng `src/lib/crypto/aesGcm.js` (Phase 1 đã có).

### 4.6. Models

`/dashboard/admin-models`:
- List + CRUD.
- Fields: provider, publicModelId, upstreamModelId, displayName, capabilities (multi), contextWindow, status.
- Tab "Grants": chọn user hoặc API key để cấp model.

API: `/<ADMIN_API_PREFIX>/models`.

### 4.7. Combos

Reuse `/dashboard/combos` hiện tại + thêm alias mount ở `/<ADMIN_API_PREFIX>/combos/*`.

### 4.8. Authentication settings

`/dashboard/admin-auth`:
- Sections: Registration · OTP · Turnstile · API Key Defaults · Logging.
- Save → PATCH `/<ADMIN_API_PREFIX>/settings/authentication`.
- Lưu vào `settings` table (extend `authSettings` JSON column).

### 4.9. Audit Logs

`/dashboard/admin-audit`:
- Table: timestamp, actor, action, entityType, entityId, ipAddress.
- Filter: actor, action, entityType, date range.
- Click row → modal: before/after JSON diff.

API: `/<ADMIN_API_PREFIX>/audit-logs?actor=...&action=...&from=...&to=...&cursor=...`.

### 4.10. System Settings

`/dashboard/admin-system`:
- Retention (request metadata / body / error / audit).
- Encryption key rotation (generate new key version, mark old as retired; future encryptions dùng key mới).
- Raw SSE debug toggle (global / per user / per key / per model / per window).
- Email template editor (HTML).

API: `/<ADMIN_API_PREFIX>/settings/system`.

### 4.11. Overview dashboard update

`/dashboard` (Overview):
- Widget: Total users, Active users, Total gateway keys, Total requests (24h), Tokens in/out (24h), Error rate, P50/P95/P99 latency, Top 5 models, Top 5 users, Provider health (UP/DEGRADED/DOWN), Credential health, Worker status (Phase 6), Queue depth (Phase 6), Generation success rate (Phase 6).

API: `/<ADMIN_API_PREFIX>/dashboard`.

### 4.12. RBAC middleware

`src/lib/admin/rbac.js`:
```js
export function requireRole(...roles) {
  return async (request) => {
    const session = await verifyAdminSession(request);
    if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!roles.includes(session.user.role)) {
      // 404 to avoid leaking admin path existence
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return null; // allowed
  };
}
```

Áp dụng cho mọi route `/<ADMIN_API_PREFIX>/*`.

### 4.13. 404 fallback

Trong `src/proxy.js` hoặc Next `not-found.js` cho path không match → trả `NextResponse.rewrite('/_404')` thay vì default Next 404 (để custom page không leak admin path).

## Acceptance criteria

1. Login bằng legacy password (`auth_token`) lần đầu → tự tạo admin user trong `users` table + set `__Secure-admin_session`.
2. Login bằng `/api/auth/login/email` với admin credentials → set `__Secure-admin_session`, KHÔNG set `__Host-client_session`.
3. Truy cập `/dashboard/users` không có admin session → redirect `/login` (hoặc 404 theo policy).
4. `GET /<ADMIN_API_PREFIX>/users` không có admin session → 401.
5. `GET /<ADMIN_API_PREFIX>/users` với `role=CLIENT` → 404 (RBAC).
6. Suspend user → tất cả `gatewayKeys` của user chuyển `revoked`.
7. Tạo credential mới qua form → DB lưu `credentialEncrypted` (AES-256-GCM), response KHÔNG trả plaintext.
8. Test credential → POST `/credentials/:id/test` gọi provider test endpoint, update `lastError` / `consecutiveFailures`.
9. Update auth settings → áp dụng ngay cho request tiếp theo (Turnstile required = true → register route fail nếu thiếu token).
10. Audit log ghi `actor=admin@local, action=VIEW_CREDENTIAL, entityId=cred_xxx` mỗi khi mở credential detail.
11. Rotate encryption key → encryptions mới dùng `keyVersion=2`, decryptions cũ vẫn đọc được (graceful).
12. **Không regress**: dashboard hiện tại (endpoint, providers, combos, usage, skills, translator, mitm, cli-tools) vẫn hoạt động bình thường với `auth_token` legacy.

## Output artifacts

- `src/lib/admin/{rbac,adminSession,encryption}.js`
- `src/lib/crypto/aesGcm.js`
- `src/app/(dashboard)/dashboard/users/page.js`
- `src/app/(dashboard)/dashboard/users/[id]/page.js`
- `src/app/(dashboard)/dashboard/admin-api-keys/page.js`
- `src/app/(dashboard)/dashboard/admin-providers/page.js`
- `src/app/(dashboard)/dashboard/admin-credentials/page.js`
- `src/app/(dashboard)/dashboard/admin-models/page.js`
- `src/app/(dashboard)/dashboard/admin-auth/page.js`
- `src/app/(dashboard)/dashboard/admin-audit/page.js`
- `src/app/(dashboard)/dashboard/admin-system/page.js`
- `src/app/api/_admin/**` (route handlers mount ở `/<ADMIN_API_PREFIX>` qua `next.config.mjs` rewrites)
- `next.config.mjs` rewrites:
  ```js
  { source: '/_dev_internal_change_me/:path*', destination: '/api/_admin/:path*' }
  ```
- `src/shared/services/initializeApp.js` mở rộng `ensureAdminUser`
- Tests: `tests/admin/*.test.js`

## Backward compat

- Dashboard cũ (endpoint, providers, combos, usage, skills, translator, mitm, cli-tools) giữ nguyên path + UI + behavior.
- API cũ (`/api/keys`, `/api/providers`, …) vẫn hoạt động với `auth_token`.
- Admin portal mới chỉ thêm pages ở `/dashboard/*` và mount thêm API ở `/<ADMIN_API_PREFIX>/*`. Không xóa/đổi behavior của code cũ.
- Khi admin click sang trang mới (Users, Credentials…) → middleware check `__Secure-admin_session` (Phase 4 mới); nếu chỉ có `auth_token` → tự động issue session admin tương ứng (backward bridge).
