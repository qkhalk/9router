# Phase 5 — Full Request Logging

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Ghi lại đầy đủ 4 lớp (Client Request, Upstream Request, Model Response, Client Response) cho mỗi request gateway. Hỗ trợ streaming reconstruction, retry/fallback attempts, encryption AES-256-GCM, secret redaction. Mở rộng `open-sse/handlers/chatCore.js` qua middleware/wrapper mà KHÔNG sửa core routing.

## Phạm vi

**Trong scope:**
- `src/lib/logging/requestLog.js` — orchestrator ghi log 4 lớp.
- `src/lib/logging/redaction.js` — strip secrets trước khi encrypt.
- `src/lib/logging/encryption.js` — wrap `aesGcm` (Phase 1).
- `src/lib/logging/streamingReconstructor.js` — append chunks → reconstructed body.
- Mở rộng `src/lib/db/schema.js` với `requestLogs`, `requestExchanges`, `requestAttempts`, `toolCallLogs`, `requestAttachments`, `usageDaily`.
- Mở rộng `src/lib/db/repos/requestLogsRepo.js`, `requestExchangesRepo.js`, `requestAttemptsRepo.js`.
- Hook vào `src/sse/handlers/chat.js`:
  - Trước khi gọi `handleChatCore` → `requestLog.start({ userId, gatewayKeyId, publicModel, clientRequest })`.
  - Sau khi parse model + chọn provider → `requestLog.addAttempt({ provider, credential, upstreamRequest })`.
  - Trong streaming path → `requestLog.appendStreamChunk(attemptId, chunk)` (chỉ nếu debug mode).
  - Cuối request → `requestLog.finalize({ statusCode, tokens, latency, clientResponse, modelResponse })`.
- `src/lib/usageDb.js` (existing) mở rộng để ghi `usageDaily` + `requestLogs`.
- Admin Request Detail UI: `src/app/(dashboard)/dashboard/admin-requests/page.js` (list) + `[id]/page.js` (detail với 11 tabs).
- API: `GET /<ADMIN_API_PREFIX>/requests`, `GET /<ADMIN_API_PREFIX>/requests/:id`, `GET /<ADMIN_API_PREFIX>/requests/:id/attempts`, `POST /<ADMIN_API_PREFIX>/requests/:id/replay`.
- Retention cron: `src/lib/retention/purge.js` chạy mỗi 6h.

**Ngoài scope:**
- Quick Generate / Start Generation (Phase 6).
- Multi-region replication (out of MVP).

## Tasks

### 5.1. Schema mở rộng

Theo plan tổng §31. Thêm vào `src/lib/db/schema.js`:

```js
requestLogs, requestExchanges, requestAttempts,
toolCallLogs, requestAttachments, usageDaily
```

Indexes:
- `requestLogs (createdAt DESC)`, `(userId, createdAt DESC)`, `(gatewayKeyId, createdAt DESC)`, `(publicModel, createdAt DESC)`, `(statusCode)`.
- `requestExchanges (requestLogId)`, `(expiresAt)` (cho retention).
- `requestAttempts (requestLogId, attemptNumber)`.

### 5.2. Encryption + redaction

```js
// src/lib/logging/encryption.js
import { encryptAesGcm, decryptAesGcm } from '@/lib/crypto/aesGcm';

export function encryptField(plaintext, keyVersion) {
  if (plaintext == null) return null;
  return encryptAesGcm(String(plaintext), keyVersion);
}

export function decryptField(cipherObj) {
  if (!cipherObj) return null;
  return decryptAesGcm(cipherObj);
}
```

```js
// src/lib/logging/redaction.js
const REDACT_KEYS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'set-cookie',
  'x-9r-cli-token', 'cf-connecting-ip', 'x-forwarded-for',
]);
const REDACT_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,                  // OpenAI/Anthropic style API key
  /ya29\.[A-Za-z0-9_-]+/g,                   // Google OAuth
  /gho_[A-Za-z0-9_]+/g,                      // GitHub OAuth
  /xox[abp]-[A-Za-z0-9-]+/g,                 // Slack
  /\b[A-Za-z0-9+/]{32,}\b/g,                 // generic long token (heuristic)
];

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = redactString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const p of REDACT_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

export function redactBody(body) {
  if (!body) return body;
  const seen = new WeakSet();
  function walk(v) {
    if (v == null) return v;
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      if (seen.has(v)) return v;
      seen.add(v);
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (['api_key', 'apiKey', 'access_token', 'refresh_token', 'password'].includes(k)) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  }
  return walk(body);
}
```

### 5.3. Request log orchestrator

```js
// src/lib/logging/requestLog.js
export class RequestLog {
  constructor({ userId, gatewayKeyId, endpoint, method, clientRequest }) {
    this.id = crypto.randomUUID();
    this.startedAt = new Date();
    this.metadata = { userId, gatewayKeyId, endpoint, method };
    this.exchangeId = null;
    this.attempts = [];
    this.statusCode = null;
  }

  async start() {
    await requestLogsRepo.create({
      id: this.id, ...this.metadata,
      startedAt: this.startedAt.toISOString(),
      createdAt: this.startedAt.toISOString(),
      statusCode: 0,
    });
    const exchangeId = await requestExchangesRepo.create({
      requestLogId: this.id,
      clientRequestHeadersEncrypted: encryptField(redactHeaders(this.metadata.clientRequest?.headers)),
      clientRequestBodyEncrypted: encryptField(redactBody(this.metadata.clientRequest?.body)),
      clientRequestSizeBytes: byteSize(this.metadata.clientRequest?.body),
    });
    this.exchangeId = exchangeId;
  }

  async addAttempt({ provider, credential, upstreamRequest, upstreamModel, upstreamEndpoint }) {
    const attemptId = crypto.randomUUID();
    await requestAttemptsRepo.create({
      id: attemptId, requestLogId: this.id,
      attemptNumber: this.attempts.length + 1,
      providerId: provider.id, providerCredentialId: credential.id,
      upstreamModel, upstreamEndpoint,
      upstreamRequestHeadersEncrypted: encryptField(redactHeaders(upstreamRequest?.headers)),
      upstreamRequestBodyEncrypted: encryptField(redactBody(upstreamRequest?.body)),
      startedAt: new Date().toISOString(),
    });
    this.attempts.push({ id: attemptId, provider, credential });
    return attemptId;
  }

  async recordAttemptResponse(attemptId, { statusCode, headers, body, latencyMs, error, inputTokens, outputTokens }) {
    await requestAttemptsRepo.update(attemptId, {
      statusCode, latencyMs,
      upstreamResponseHeadersEncrypted: encryptField(redactHeaders(headers)),
      upstreamResponseBodyEncrypted: encryptField(redactBody(body)),
      inputTokens, outputTokens,
      errorCode: error?.code, errorMessage: error?.message,
      completedAt: new Date().toISOString(),
    });
  }

  async appendStreamChunk(attemptId, chunk) {
    // Only when storeRawSseChunks enabled
    // Reconstruct modelResponse and clientResponse on finalize
    if (!this._reconstructed) this._reconstructed = { model: '', client: '' };
    this._reconstructed.model += chunk.model || '';
    this._reconstructed.client += chunk.client || '';
  }

  async finalize({ statusCode, modelResponse, clientResponse, finishReason, inputTokens, outputTokens, latencyMs, timeToFirstTokenMs, error, retryCount, fallbackCount, selectedAttemptId }) {
    await requestExchangesRepo.update(this.exchangeId, {
      finalClientResponseHeadersEncrypted: encryptField(redactHeaders(clientResponse?.headers)),
      finalClientResponseBodyEncrypted: encryptField(redactBody(clientResponse?.body)),
      assistantResponseTextEncrypted: encryptField(extractText(modelResponse)),
      systemPromptTextEncrypted: encryptField(extractSystemPrompt(this.metadata.clientRequest?.body)),
      userPromptTextEncrypted: encryptField(extractUserPrompt(this.metadata.clientRequest?.body)),
      clientResponseSizeBytes: byteSize(clientResponse?.body),
    });
    await requestLogsRepo.update(this.id, {
      statusCode, finishReason,
      inputTokens, outputTokens, totalTokens: (inputTokens || 0) + (outputTokens || 0),
      latencyMs, timeToFirstTokenMs,
      retryCount, fallbackCount, selectedAttemptId,
      errorCode: error?.code, errorMessage: error?.message,
      completedAt: new Date().toISOString(),
    });
    // Increment usageDaily
    await usageDailyRepo.increment(this.metadata, { inputTokens, outputTokens, success: statusCode < 400 });
  }
}
```

### 5.4. Hook vào `open-sse/handlers/chatCore.js`

**Quan trọng**: KHÔNG sửa `chatCore.js`. Thay vào đó, wrap nó:

```js
// src/sse/handlers/chat.js
import { originalHandleChatCore } from 'open-sse/handlers/chatCore.js';

export async function handleChat(request) {
  const log = new RequestLog({ userId, gatewayKeyId, endpoint, method, clientRequest: parsed });
  await log.start();
  try {
    // gọi chatCore, nhưng truyền callback để ghi attempt
    const result = await instrumentedHandleChat({ request, requestLog: log });
    await log.finalize({ ...result, statusCode: 200 });
    return result.response;
  } catch (err) {
    await log.finalize({ statusCode: err.statusCode || 500, error: err });
    throw err;
  }
}
```

Instrumented wrapper:
- Trước khi gọi `getProviderCredentials` → lưu resolved `provider, credential, upstreamModel` cho attempt.
- Ngay sau khi gọi `executor.execute(...)` → nếu fail → ghi `recordAttemptResponse(... { statusCode: err.statusCode, error: err })`. Nếu thành công → `recordAttemptResponse(... { statusCode: 200, ... })`.
- Streaming: trong `streamHandler.js` (cũng là `open-sse/utils/streamHandler.js`), nếu `requestLog` được pass qua → append từng chunk vào `log._reconstructed` (chỉ khi `storeRawSseChunks`).

Vì không được sửa `chatCore.js`, ta sẽ:
- Tạo `src/sse/handlers/chatInstrumented.js` là bản fork nhỏ của `chat.js` (gọi `chatCore` như cũ + thêm log calls). Phase sau có thể upstream lại core.
- Hoặc: tạo wrapper module `src/sse/handlers/chatWithLogging.js` thay thế default `handleChat` trong `route.js`.

Quyết định: dùng wrapper để không đụng core. `route.js` import từ wrapper.

### 5.5. Streaming reconstruction

```js
// src/lib/logging/streamingReconstructor.js
export class StreamingReconstructor {
  constructor() {
    this.modelText = '';
    this.clientText = '';
    this.chunkCount = 0;
    this.firstChunkAt = null;
    this.lastChunkAt = null;
  }
  push(providerChunk, clientChunk) {
    this.chunkCount++;
    const now = Date.now();
    if (!this.firstChunkAt) this.firstChunkAt = now;
    this.lastChunkAt = now;
    this.modelText += providerChunk;
    this.clientText += clientChunk;
  }
  finalize() {
    return {
      model: this.modelText,
      client: this.clientText,
      chunkCount: this.chunkCount,
      firstChunkAt: this.firstChunkAt,
      lastChunkAt: this.lastChunkAt,
    };
  }
}
```

### 5.6. Admin Request Detail UI

`/dashboard/admin-requests`:
- Table: requestId, user, publicModel, statusCode, latency, tokens, attempts, createdAt.
- Filter: user, publicModel, status, date range, latency range, has error.
- Click row → `/dashboard/admin-requests/[id]`.

`/dashboard/admin-requests/[id]`:
- Header: user, gatewayKey (masked), publicModel, upstreamModel, provider, credential, status, duration, attempts, error.
- Tabs: Overview · Client Request · Upstream Request · Model Response · Client Response · Routing Trace · Attempts · Tokens & Timing · Errors · Security.
- Mỗi tab render JSON viewer (Monaco editor read-only) với decrypt tự động.
- Mỗi lần mở tab "Client Request" hoặc "Model Response" → ghi `auditLog(action='VIEW_REQUEST_CONTENT', requestId=...)`.

### 5.7. API endpoints

```js
// GET /<ADMIN_API_PREFIX>/requests
// Query: userId, publicModel, statusCode, from, to, cursor, limit
// → { items: [{ id, userId, publicModel, resolvedModel, statusCode, latencyMs, attempts, createdAt }], nextCursor }

// GET /<ADMIN_API_PREFIX>/requests/:id
// → { ...metadata, exchange: { clientRequest, normalizedRequest, clientResponse, systemPrompt, userPrompt, assistantResponse, reasoning }, attempts: [...] }

// POST /<ADMIN_API_PREFIX>/requests/:id/replay
// → gọi lại request với cùng key + model + body (re-encrypt client request nếu cần) → trả response mới
```

### 5.8. Retention cron

`src/lib/retention/purge.js`:
```js
export async function runRetention() {
  const settings = await getSettings();
  const now = Date.now();
  await requestLogsRepo.deleteOlderThan(daysAgo(settings.retention.requestMetadata));
  await requestExchangesRepo.deleteOlderThan(daysAgo(settings.retention.requestBody));
  await requestLogsRepo.deleteErrorsOlderThan(daysAgo(settings.retention.error));
  await auditLogsRepo.deleteOlderThan(daysAgo(settings.retention.audit));
}
```

Schedule: chạy trong `src/shared/services/initializeApp.js` mỗi 6h (setInterval + idempotent guard).

### 5.9. Logging không được break request

Tất cả `try/catch` quanh mọi `requestLog.*` call. Nếu logging fail → log warning console, KHÔNG throw.

```js
async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.warn('logging failed:', e.message); return fallback; }
}
```

## Acceptance criteria

1. Mỗi request `/v1/chat/completions` với `sk-` key → tạo 1 row `requestLogs` + 1 row `requestExchanges` + ≥1 row `requestAttempts`.
2. DB KHÔNG chứa plaintext: tất cả cột `*Encrypted` đều là `{ encryptedPayload, iv, authTag, keyVersion }`.
3. `Authorization: Bearer sk-...` trong header → lưu `[REDACTED]`.
4. Provider response chứa API key trong body → lưu `[REDACTED]`.
5. Streaming request → reconstructed `modelResponse` đầy đủ text cuối cùng (test với chunk 10+).
6. Retry (HTTP 429 → retry credential khác) → 2 rows `requestAttempts`, đúng `attemptNumber`, `wasSelected` chỉ true ở attempt thành công.
7. Combo fallback (model A fail → model B success) → 2 rows `requestAttempts` với `provider` khác nhau.
8. `usageDaily` tăng đúng theo `inputTokens/outputTokens` của request thành công.
9. Admin mở `/dashboard/admin-requests/[id]` → tab "Client Request" → ghi `auditLog(action='VIEW_REQUEST_CONTENT')`.
10. Retention cron: sau khi set `retention.requestBody=7d` + tạo request cũ giả lập → cron xóa `requestExchanges` cũ, giữ `requestLogs` metadata.
11. Logging error (giả lập DB lock) → request client vẫn nhận response 200.
12. `POST /<ADMIN_API_PREFIX>/requests/:id/replay` → gọi lại với cùng body, trả response mới (audit logged).
13. **Không regress**: `/v1/models` và `/v1/chat/completions` local mode (`requireApiKey=false`) vẫn chạy nhanh (overhead logging < 50ms p95 cho request non-stream).

## Output artifacts

- `src/lib/logging/{requestLog,redaction,encryption,streamingReconstructor}.js`
- `src/lib/crypto/aesGcm.js` (nếu chưa có từ Phase 1)
- `src/lib/db/repos/{requestLogsRepo,requestExchangesRepo,requestAttemptsRepo,usageDailyRepo}.js`
- Mở rộng `src/lib/db/schema.js`
- `src/sse/handlers/chatInstrumented.js` (wrapper)
- Cập nhật `src/app/api/v1/chat/completions/route.js` (dùng wrapper)
- Cập nhật `src/sse/handlers/chat.js` tương tự cho `/api/v1/responses`, `/api/v1/messages`
- `src/app/(dashboard)/dashboard/admin-requests/page.js` + `[id]/page.js`
- `src/app/api/_admin/requests/**/route.js`
- `src/lib/retention/purge.js`
- Tests: `tests/logging/*.test.js`, `tests/integration/request-lifecycle.test.js`

## Backward compat

- `requestDetails` table cũ (SQLite) giữ nguyên; Phase 5 mở rộng thêm `requestLogs/Exchanges/Attempts`. Có thể giữ `requestDetails` làm cache/index cho Dashboard cũ (Usage page), vì nó đã có sẵn logic truy vấn.
- `usageDb.js` (existing) làm shim gọi sang `usageDailyRepo` mới; không đổi call sites cũ.
- `open-sse/chatCore.js` KHÔNG sửa. Wrapper mới gọi `chatCore` y hệt cũ.
