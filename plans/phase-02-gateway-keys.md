# Phase 2 — API Key & Gateway Authorization

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Sinh `sk-…` cho client, lưu hash, kiểm tra model permission + quota + rate-limit + suspend/revoke, integrate vào `/v1/*` mà KHÔNG phá vỡ `open-sse/handlers/chatCore.js` hiện tại.

## Phạm vi

**Trong scope:**
- `src/lib/client/gatewayKey.js` — generate, hash, verify, rotate, revoke.
- `src/lib/client/quota.js` — tokensPerDay / tokensPerMonth / requestsPerMinute (in-memory token bucket + daily counter).
- Mở rộng `src/lib/db/schema.js` với `gatewayKeys`, `gatewayKeyModelPolicies`, `usageDaily` (nếu chưa có).
- Hook vào `src/sse/handlers/chat.js` (ngay sau khi parse body) để:
  1. Extract `Authorization: Bearer <sk>`.
  2. Verify hash.
  3. Check key status, user status, expiration.
  4. Check rate-limit + quota.
  5. Check model permission (`gatewayKeyModelPolicies`).
  6. Gắn `req.gatewayKeyContext = { userId, keyId, publicModel, ... }` cho middleware downstream.
- Client API endpoints:
  - `GET    /api/client/api-keys`
  - `POST   /api/client/api-keys`
  - `PATCH  /api/client/api-keys/:id`
  - `DELETE /api/client/api-keys/:id`
  - `POST   /api/client/api-keys/:id/rotate`
  - `GET    /api/client/models` (filter theo allowed models của user)

**Ngoài scope:**
- Full request body logging (Phase 5).
- Activity feed (Phase 3).
- Admin revoke/suspend (Phase 4).

## Tasks

### 2.1. Key generation

```js
// src/lib/client/gatewayKey.js
import crypto from 'node:crypto';

const PEPPER = process.env.GATEWAY_KEY_PEPPER || 'change-me-pepper';

export function generateGatewayKey() {
  const random = crypto.randomBytes(32); // 32 bytes → 43 base64url chars
  const key = 'sk-' + random.toString('base64url');
  const keyPrefix = key.slice(0, 7);     // 'sk-AbCd'
  const lastFour = key.slice(-4);
  return { key, keyPrefix, lastFour };
}

export function hashGatewayKey(key) {
  return crypto.createHmac('sha256', PEPPER).update(key).digest('hex');
}
```

DB row:
```
gatewayKeys(
  id, userId, name, keyPrefix, keyHash, lastFour,
  status: 'active' | 'revoked',
  expiresAt, lastUsedAt, lastUsedIp,
  requestsPerMinute, tokensPerDay, tokensPerMonth,
  createdAt, revokedAt
)
```

**KHÔNG lưu plaintext**. Hiển thị plaintext 1 lần ở response của `POST /api/client/api-keys`.

### 2.2. Verification (constant-time)

```js
export async function verifyGatewayKey(key) {
  const keyHash = hashGatewayKey(key);
  const row = await gatewayKeysRepo.findByHash(keyHash);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'active') return { ok: false, reason: 'revoked' };
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) return { ok: false, reason: 'expired' };
  const user = await usersRepo.findById(row.userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  if (!['ACTIVE'].includes(user.status)) return { ok: false, reason: 'user_inactive' };
  return { ok: true, key: row, user };
}
```

Lưu ý: KHÔNG dùng lookup `key === ?` (đã có trong `apiKeys` cũ); dùng `keyHash` index.

### 2.3. Quota & rate limit

`src/lib/client/quota.js`:
- In-memory token bucket: `requestsPerMinute` (sliding 60s window per key).
- Daily counter: `tokensPerDay` (reset 00:00 UTC).
- Monthly counter: `tokensPerMonth` (reset ngày 1 UTC).
- Persist vào `usageDaily` table khi request complete (Phase 5 sẽ ghi chi tiết hơn; Phase 2 chỉ cần increment cho rate-limit).

Khi vượt → 429 với header `Retry-After`.

### 2.4. Model permission

`gatewayKeyModelPolicies` cho phép per-key override. Mặc định nếu không có row nào → dùng `models.status === 'enabled'` + `userModelGrants` (Phase 4 admin set).

Phase 2 MVP: nếu user không có row nào trong `gatewayKeyModelPolicies` → cho phép TẤT CẢ model `status='enabled'`. Phase 4 siết lại.

### 2.5. Hook vào `/v1/*`

Mở `src/sse/handlers/chat.js`, ngay sau khi parse body:

```js
// Ngay sau dòng: const apiKey = extractApiKey(request);
if (apiKey && apiKey.startsWith('sk-')) {
  // Try client gateway key verification (new format: sk-<base64url>)
  // If format matches new and not found in apiKeys (old), try gatewayKeys table
  const verification = await verifyGatewayKeyIfClient(apiKey);
  if (verification?.ok) {
    const perm = await checkModelPermission(verification.key.id, body.model);
    if (!perm.ok) return errorResponse(403, `Model ${body.model} not allowed for this key`);
    const quota = await checkQuota(verification.key.id);
    if (!quota.ok) return errorResponse(429, quota.reason);
    // Attach context for logging layer (Phase 5)
    request.gatewayKeyContext = {
      userId: verification.user.id,
      gatewayKeyId: verification.key.id,
      publicModel: body.model,
    };
  } else if (verification?.reason === 'not_found') {
    // Try existing internal apiKeys for backward compat
    // (existing logic: if requireApiKey → check apiKeys; else allow)
  }
}
```

Đảm bảo KHÔNG đổi behavior của `requireApiKey=false` (local mode) hiện tại.

### 2.6. Client API endpoints

Mount dưới `/api/client/api-keys/*`. Tất cả check `verifyClientSession` (Phase 1) trước.

```js
// POST /api/client/api-keys
// Body: { name, modelIds: [...], expiresIn: '30d' | 'never', rpm?, tpd?, tpm? }
// → generate + insert + return { key, keyPrefix, lastFour, id, ... }  (1 lần)
```

```js
// DELETE /api/client/api-keys/:id
// → status='revoked', revokedAt=now()
```

```js
// POST /api/client/api-keys/:id/rotate
// → generate new key, revoke old, return { key, ... }  (1 lần)
```

```js
// GET /api/client/models
// → trả models mà admin enabled VÀ key được phép gọi (filter theo gatewayKeyModelPolicies nếu có)
// Client KHÔNG thấy provider, upstreamModelId, ...
```

### 2.7. Update `proxy.js`

`/v1/*` đã public; nhưng nếu `apiKey` extract được từ `Authorization: Bearer` match `sk-` và KHÔNG tìm thấy trong `gatewayKeys`/`apiKeys`:
- Nếu `requireApiKey=true` (setting) → 401.
- Nếu `requireApiKey=false` (local mode) → cho qua (giữ behavior cũ).

Logic ở `src/dashboardGuard.js:131` (`canAccessPublicLlmApi`) cần xử lý 2 loại key.

## Acceptance criteria

1. Tạo user ACTIVE + session hợp lệ (Phase 1) → `POST /api/client/api-keys` happy path → trả `{ key: "sk-...", keyPrefix, lastFour, id }`.
2. DB row `gatewayKeys` có `keyHash`, KHÔNG có `key` plaintext.
3. `POST /api/client/api-keys` lần 2 với cùng user → tăng count; đến `maxKeysPerUser` (default 5) → 400.
4. Gọi `POST /v1/chat/completions` với key vừa tạo + model được cấp → 200.
5. Gọi `POST /v1/chat/completions` với key vừa tạo + model KHÔNG được cấp → 403.
6. Gọi với key đã `revoked` → 401.
7. Gọi với key hết hạn → 401.
8. Spam 100 request/phút với rpm=60 → 429 sau request 60.
9. Vượt `tokensPerDay` → 429.
10. `DELETE /api/client/api-keys/:id` → key không dùng được nữa, response 200.
11. `POST /api/client/api-keys/:id/rotate` → key mới hoạt động, key cũ revoked.
12. `GET /api/client/models` trả đúng model list (chỉ enabled, không lộ provider).
13. **Không regress**: dashboard password login (`auth_token` cookie) vẫn hoạt động; `/api/keys` cũ vẫn trả key list cho dashboard.

## Output artifacts

- `src/lib/client/{gatewayKey,quota,modelPermission}.js`
- `src/lib/db/repos/gatewayKeysRepo.js`
- Mở rộng `src/lib/db/schema.js`: `gatewayKeys`, `gatewayKeyModelPolicies`, `usageDaily`
- `src/sse/handlers/chat.js` hook
- `src/app/api/client/api-keys/route.js`
- `src/app/api/client/api-keys/[id]/route.js`
- `src/app/api/client/api-keys/[id]/rotate/route.js`
- `src/app/api/client/models/route.js`
- `src/dashboardGuard.js` cập nhật (handle 2 loại sk- key)
- Tests: `tests/gateway-keys/*.test.js`

## Backward compat

- `apiKeys` table cũ + `/api/keys` route GIỮ NGUYÊN cho internal dashboard key.
- `requireApiKey=false` (default) → `/v1/*` vẫn hoạt động không cần key (giữ nguyên).
- `requireApiKey=true` + key cũ format `sk-{machineId}-{keyId}-{crc8}` → verify trong `apiKeys` table.
- `requireApiKey=true` + key mới format `sk-<base64url>` → verify trong `gatewayKeys` table mới.
- `open-sse/chatCore.js` KHÔNG đổi.
