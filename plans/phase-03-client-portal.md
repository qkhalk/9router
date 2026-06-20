# Phase 3 — Client Portal

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

UI Client Portal: Dashboard, API Keys, Models, Request Activity (chỉ time + public model), Usage, Playground, API Docs, Account. Dùng Next.js route group `(client)` riêng; tách bundle với admin qua middleware + lazy import.

## Phạm vi

**Trong scope:**
- `src/app/(client)/layout.js` — layout chung (header, sidebar, theme).
- `src/app/(client)/page.js` — landing.
- `src/app/(client)/login/page.js` — login form (Google + Email/Password).
- `src/app/(client)/register/page.js` — register form.
- `src/app/(client)/verify-email/page.js` — nhập OTP.
- `src/app/(client)/verify-login/page.js` — nhập OTP login.
- `src/app/(client)/forgot-password/page.js`.
- `src/app/(client)/app/page.js` — Dashboard.
- `src/app/(client)/app/api-keys/page.js`.
- `src/app/(client)/app/models/page.js`.
- `src/app/(client)/app/activity/page.js`.
- `src/app/(client)/app/usage/page.js`.
- `src/app/(client)/app/playground/page.js`.
- `src/app/(client)/app/api-docs/page.js`.
- `src/app/(client)/app/account/page.js`.
- Reuse: 9Router UI components sẵn có trong `src/shared/components/`.
- Theme: copy từ dashboard hiện tại (Tailwind + Material Symbols).

**Ngoài scope:**
- Admin Portal UI (Phase 4).
- Full request body viewer (chỉ admin).
- Quick Generate UI (chỉ admin).

## Tasks

### 3.1. Route group setup

`src/app/(client)/layout.js`:
- Lấy session từ `__Host-client_session`.
- Nếu không có + path ngoài public (`/login`, `/register`, `/verify-*`, `/forgot-password`) → redirect `/login`.
- Render `<ClientShell>` (header + sidebar + content).

ESLint rule chặn:
```js
// .eslintrc
"no-restricted-imports": ["error", {
  patterns: [
    { group: ["@/app/(dashboard)/*"], message: "Client portal cannot import admin code" },
    { group: ["@/lib/admin/*"], message: "Client portal cannot use admin modules" },
  ]
}]
```

### 3.2. Login / Register / Verify pages

#### Login (`/login`)
- Button "Continue with Google" → redirect `/api/auth/register/google` (Phase 1 đã tạo).
- Form Email + Password + Turnstile widget → POST `/api/auth/login/email`.
- Nếu `requiresOtp` → redirect `/verify-login?challenge=...`.

#### Register (`/register`)
- Form Email + Password + Confirm Password + Turnstile.
- POST `/api/auth/register/email`.
- Success → redirect `/verify-email?user=...&challenge=...`.

#### Verify email (`/verify-email`)
- Form 6 ô input OTP (auto-focus next).
- POST `/api/auth/verify-registration`.
- Success → set session cookie (response) → redirect `/app`.

### 3.3. Dashboard (`/app`)

Hiển thị (từ `GET /api/client/dashboard`):
- Tổng request hôm nay, tuần, tháng.
- Input/output token hôm nay.
- Quota còn lại (progress bar).
- Usage 7 ngày gần nhất (recharts sparkline).
- Top 5 model.
- Success rate.

Component reuse: `src/shared/components/charts/` nếu có.

### 3.4. API Keys (`/app/api-keys`)

- List key (table): name, keyPrefix••••lastFour, status, expiresAt, lastUsedAt, actions.
- Button "Create key" → modal: name, models (multi-select), expiration, rpm, tpd, tpm.
- Submit → POST `/api/client/api-keys` → response modal show plaintext **1 lần** + button "Copy" + warning "Save this key now. You won't see it again."
- Actions per row: Rename (PATCH), Rotate (POST `/rotate`), Revoke (DELETE).

### 3.5. Models (`/app/models`)

- Grid card: display name, capability icon, status badge.
- Filter by capability (chat / image / embedding / audio).
- Click card → modal chi tiết (context window, max output, giới hạn key gọi được model này).

### 3.6. Request Activity (`/app/activity`)

- Table: createdAt | model.
- Pagination cursor-based.
- **KHÔNG** có filter nào khác ngoài date range.
- Tooltip: "Only time and public model are visible. Prompts and responses are private."

### 3.7. Usage (`/app/usage`)

- Daily chart (recharts line): request count, token in/out.
- Per-model bar chart.
- Date range picker.

### 3.8. Playground (`/app/playground`)

- Chọn API key (dropdown), model (dropdown).
- System prompt textarea.
- User prompt textarea.
- Toggle Streaming.
- Button "Send" → POST `/api/client/playground` (proxy đến `/v1/chat/completions` với key đã chọn).
- Hiển thị response raw JSON (nếu non-stream) hoặc append từng chunk (nếu stream).
- Button "Copy as cURL", "Copy as Python", "Copy as JS".
- **KHÔNG lưu response**. Sau khi rời trang → mất.

### 3.9. API Docs (`/app/api-docs`)

- Static markdown render từ `gitbook/` (đã có sẵn ở 9Router) hoặc file mới `src/app/(client)/app/api-docs/content.md`.
- Ví dụ cURL, Python, JS cho `/v1/chat/completions`, `/v1/embeddings`, `/v1/images/generations`.
- Hiển thị endpoint base = window.location.origin.

### 3.10. Account (`/app/account`)

- Profile: email, username, role, status, emailVerifiedAt.
- Change password (re-auth bằng OTP).
- Change email (OTP verify new email).
- Sessions list: device, IP, last used, revoke.
- Delete account (soft delete, confirm modal).

### 3.11. Proxy guard

`src/proxy.js`: bổ sung check cho `/app/*` → require `verifyClientSession`. Nếu fail → redirect `/login?next=...`.

### 3.12. i18n

9Router đã có `src/i18n/` (vi/en/zh). Mở rộng translations cho client portal pages.

## Acceptance criteria

1. Anonymous visit `/app` → redirect `/login`.
2. Login Google thành công → redirect `/app` (Dashboard render).
3. Login email + password → redirect `/verify-login` → nhập OTP → `/app`.
4. Tạo API key → modal hiển thị plaintext 1 lần, copy button hoạt động.
5. Reload page sau khi đóng modal → KHÔNG xem lại plaintext.
6. DB `gatewayKeys.keyHash` tồn tại, `key` column KHÔNG có plaintext.
7. Revoke key → row chuyển status `revoked`, list update.
8. Activity page chỉ hiển thị `createdAt` + `model`. KHÔNG có prompt/response/provider/routing.
9. Network tab khi load `/app/activity` → response chỉ chứa `{items: [{createdAt, model}]}`.
10. Playground: chọn key, gõ prompt, gửi → response hiển thị raw JSON / streaming chunks. Rời trang → quay lại → response trống.
11. Build: `npm run build` exit 0, không warning import admin trong client bundle.
12. ESLint rule: cố tình `import '@/app/(dashboard)/...'` từ client → lỗi lint.
13. i18n: chuyển sang `vi` → toàn bộ text client portal dịch sang tiếng Việt.

## Output artifacts

- `src/app/(client)/layout.js` + 12 page files
- `src/components/client/{ClientShell,Sidebar,Header,OtpInput,TurnstileWidget,KeyCreateModal,KeyRow}.jsx`
- `src/lib/client/dashboard.js` (aggregation queries)
- `src/lib/client/playground.js` (proxy + streaming passthrough)
- `src/app/api/client/dashboard/route.js`
- `src/app/api/client/playground/route.js`
- Cập nhật `src/proxy.js` + `src/dashboardGuard.js`
- `src/i18n/locales/{vi,en}.json` mở rộng
- `.eslintrc` rule
- Tests: `tests/client-portal/*.test.js` (vitest + Playwright cho E2E login flow)

## Backward compat

- Dashboard cũ ở `/dashboard/*` KHÔNG bị ảnh hưởng (route group riêng).
- `(client)` route group chỉ match các path mới; existing paths giữ nguyên.
