# Phase 6 — Quick Generate & Start Generation

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Cho phép admin tạo thêm provider credential hàng loạt bằng Quick Generate (HTTP/API) hoặc Start Generation (browser worker). Chạy qua job queue (in-process MVP), worker heartbeat, retry/cancel, progress, history. Client KHÔNG truy cập được.

## Phạm vi

**Trong scope:**
- Schema mở rộng: `generationBatches`, `generationJobs`, `workers`.
- `src/lib/generation/queue.js` — in-process queue (Map + Promise workers), idempotent enqueue, persist vào DB.
- `src/lib/generation/quickGen.js` — adapter gọi provider OAuth/device-code API trực tiếp (no browser).
- `src/lib/generation/browserAdapter.js` — adapter giao tiếp với browser worker process (chạy riêng Phase 6+; MVP có thể stub nếu không có worker process thật).
- `src/lib/generation/workerRegistry.js` — heartbeat + capacity + version.
- `src/lib/generation/runner.js` — pick job → run adapter → update progress → test credential → save encrypted → complete.
- `src/lib/generation/credentialTester.js` — gọi provider test endpoint để verify credential hoạt động trước khi active.
- API: `/<ADMIN_API_PREFIX>/generation/quick`, `/generation/browser`, `/generation/batches`, `/generation/batches/:id`, `/generation/batches/:id/cancel`, `/generation/jobs/:id/retry`, `/workers`.
- Admin UI: `/dashboard/admin-generation/page.js` (list batches + create) + `[id]/page.js` (detail + job list + cancel/retry).
- Sidebar widget: `Generation Success Rate (24h)`, `Queue Depth`, `Worker Status`.

**Ngoài scope:**
- Distributed queue (Redis/Kafka) — Phase 7 optional.
- Provider-specific OAuth flows cho tất cả providers (MVP chỉ support 1–2 provider đầu tiên, dùng `codex` và `cursor` có sẵn logic OAuth trong 9Router).
- Auto-scale worker pool.

## Tasks

### 6.1. Schema mở rộng

Thêm vào `src/lib/db/schema.js`:

```js
generationBatches(
  id, mode: 'quick' | 'browser',
  providerId, requestedCount, successCount, failedCount,
  status: 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed',
  createdBy, configEncrypted,
  startedAt, completedAt, createdAt
)

generationJobs(
  id, batchId,
  status: 'queued' | 'running' | 'waiting_email' | 'waiting_otp'
        | 'waiting_manual_action' | 'retrying'
        | 'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled',
  currentStep, progress: 0..100,
  workerId, attempt: int,
  email, username,
  resultCredentialId,
  errorCode, errorMessage, errorStackEncrypted,
  startedAt, completedAt, createdAt
)

workers(
  id, name, mode: 'quick' | 'browser',
  status: 'idle' | 'busy' | 'offline' | 'error',
  version, lastHeartbeatAt,
  activeJobs, capacity: int,
  configEncrypted,
  createdAt, updatedAt
)
```

Indexes:
- `generationJobs (batchId, status)`, `(status, createdAt)`.
- `workers (status, lastHeartbeatAt)`.

### 6.2. In-process queue (MVP)

```js
// src/lib/generation/queue.js
import { EventEmitter } from 'node:events';

class JobQueue extends EventEmitter {
  constructor() {
    super();
    this.pending = [];      // jobIds
    this.running = new Map(); // jobId → workerName
    this.concurrency = 3;
    this.tickHandle = null;
  }
  async enqueue(jobId) {
    this.pending.push(jobId);
    await this.persistPending(jobId);
    this.emit('enqueue', jobId);
    this.scheduleTick();
  }
  async cancel(jobId) {
    this.pending = this.pending.filter(id => id !== jobId);
    if (this.running.has(jobId)) {
      // signal worker to stop
      this.emit('cancel', jobId);
    }
    await jobsRepo.update(jobId, { status: 'cancelled', completedAt: new Date().toISOString() });
  }
  scheduleTick() {
    if (this.tickHandle) return;
    this.tickHandle = setImmediate(() => this.tick());
  }
  async tick() {
    this.tickHandle = null;
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const jobId = this.pending.shift();
      const job = await jobsRepo.findById(jobId);
      if (!job || job.status === 'cancelled') continue;
      this.running.set(jobId, 'self');
      this.runJob(job).catch(err => console.error('job error', err));
    }
  }
  async runJob(job) {
    try {
      await jobsRepo.update(job.id, { status: 'running', startedAt: new Date().toISOString() });
      const adapter = job.batch.mode === 'quick' ? quickGen : browserAdapter;
      const result = await adapter.run(job, {
        onProgress: async (p) => await jobsRepo.update(job.id, { progress: p }),
        onWait: async (state) => await jobsRepo.update(job.id, { status: state, currentStep: state }),
        cancelToken: { cancelled: false, onCancel: (fn) => this.once(`cancel:${job.id}`, fn) },
      });
      // Test credential
      const tested = await credentialTester.test(result.credential, job.provider);
      if (!tested.ok) throw new Error('credential_test_failed: ' + tested.error);
      // Encrypt + save
      const credentialRow = await providerCredentialsRepo.create({
        providerId: job.providerId,
        name: result.name || `gen-${Date.now()}`,
        credentialEncrypted: encryptField(result.credential),
        keyVersion: ENCRYPTION_KEY_VERSION,
        status: 'active',
      });
      await jobsRepo.update(job.id, {
        status: 'succeeded', progress: 100,
        resultCredentialId: credentialRow.id, completedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err.cancelled) {
        await jobsRepo.update(job.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      } else {
        await jobsRepo.update(job.id, {
          status: 'failed', errorCode: err.code, errorMessage: err.message,
          errorStackEncrypted: encryptField(err.stack),
          completedAt: new Date().toISOString(),
        });
      }
    } finally {
      this.running.delete(job.id);
      this.scheduleTick();
    }
  }
}

if (!global._jobQueue) global._jobQueue = new JobQueue();
export const jobQueue = global._jobQueue;
```

Singleton qua `global` để survive Next.js HMR (giống pattern `usageDb.js` hiện tại).

### 6.3. Quick Generate adapter

`src/lib/generation/quickGen.js`:
- Lấy `provider` config từ DB.
- Gọi provider OAuth/device-code API tương ứng.
- Reuse 9Router OAuth handlers hiện có: `src/app/api/oauth/[provider]/[action]/route.js` (chỉ cần import internal handler, không cần qua HTTP).

```js
import { exchangeCodexToken, exchangeCursorToken } from '@/lib/oauth/adapters';

export async function run(job, { onProgress, onWait, cancelToken }) {
  const config = JSON.parse(decryptField(job.batch.configEncrypted));
  if (job.provider.code === 'codex') {
    return await runCodex(config, { onProgress, onWait, cancelToken });
  }
  if (job.provider.code === 'cursor') {
    return await runCursor(config, { onProgress, onWait, cancelToken });
  }
  throw new Error(`Provider ${job.provider.code} not supported in quick gen`);
}

async function runCodex(config, hooks) {
  // OpenAI Codex device flow
  // 1. request device code
  // 2. onWait('waiting_email') or 'waiting_otp'
  // 3. poll until authorized
  // 4. exchange → { access_token, refresh_token, account_id }
  // 5. test by calling /v1/models with bearer
  // return { credential: { access_token, refresh_token, account_id, email } }
}
```

### 6.4. Browser worker adapter

`src/lib/generation/browserAdapter.js`:
- Browser worker chạy tách process (Phase 6+ có thể stub bằng `puppeteer-core` in-process nếu env cho phép, nhưng MVP sẽ để stub và document).
- Worker expose HTTP API `POST /jobs/:id/run` trên port 3010 (configurable).
- Adapter gọi worker API + poll job status.

```js
export async function run(job, hooks) {
  const worker = await workersRepo.findById(job.workerId);
  if (!worker || worker.status === 'offline') throw new Error('worker_offline');
  const res = await fetch(`${worker.endpoint}/jobs/${job.id}/run`, {
    method: 'POST',
    headers: { 'x-worker-token': decryptField(worker.configEncrypted).token },
    body: JSON.stringify({ provider: job.provider, config: decryptField(job.batch.configEncrypted) }),
  });
  if (!res.ok) throw new Error('worker_request_failed');
  return await res.json();
}
```

**MVP decision**: nếu không có browser worker process thật, browserAdapter throw `not_implemented_yet`. Admin vẫn dùng được Quick Generate.

### 6.5. Worker registry

`src/lib/generation/workerRegistry.js`:
- Workers tự register qua `POST /<ADMIN_API_PREFIX>/workers` (gửi name, mode, version, capacity).
- Heartbeat mỗi 30s: `POST /workers/:id/heartbeat`.
- Background task mỗi 60s: mark worker `offline` nếu `lastHeartbeatAt > 90s ago`.
- Self-registration cho in-process worker (queue tự register 1 worker `in-process-quick` với capacity = queue.concurrency).

### 6.6. Credential tester

`src/lib/generation/credentialTester.js`:
- Gọi provider test endpoint phù hợp.
- Ví dụ: OpenAI → `GET https://api.openai.com/v1/models` với `Authorization: Bearer <key>`. Nếu 200 → ok.
- Codex → `GET /v1/models` với bearer.
- Anthropic → `POST /v1/messages` với `max_tokens: 1` (để check 401/200).

```js
export async function test(credential, provider) {
  try {
    const res = await provider.testFetch(credential);
    return { ok: res.status < 400, status: res.status, error: res.status >= 400 ? res.body : null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

### 6.7. Admin API

```js
// POST /<ADMIN_API_PREFIX>/generation/quick
// Body: { providerId, quantity, concurrency?, retry?, delay?, proxy?, credentialGroup?, priority?, autoActivate?, dryRun? }
// → create generationBatches (mode=quick) + N generationJobs → enqueue
//   Returns { batchId, jobIds: [...] }

// POST /<ADMIN_API_PREFIX>/generation/browser
// Body: { providerId, workerId, browserProfile, headless?, proxyPoolId?, quantity, ... }
// → create generationBatches (mode=browser) + jobs

// GET /<ADMIN_API_PREFIX>/generation/batches
// → list với filter (status, mode, provider, createdBy, date range)
//   Returns { items: [{ id, mode, provider, status, requested, success, failed, progress, createdBy, createdAt, completedAt }], nextCursor }

// GET /<ADMIN_API_PREFIX>/generation/batches/:id
// → batch detail + jobs + per-job log steps
//   Returns { ...batch, jobs: [{ id, status, currentStep, progress, workerId, attempt, errorCode, errorMessage, startedAt, completedAt }] }

// POST /<ADMIN_API_PREFIX>/generation/batches/:id/cancel
// → cancel all queued + running jobs

// POST /<ADMIN_API_PREFIX>/generation/jobs/:id/retry
// → reset job, re-enqueue (giữ nguyên batchId)

// GET /<ADMIN_API_PREFIX>/workers
// → list workers với lastHeartbeat, activeJobs, status
```

### 6.8. Admin UI

`/dashboard/admin-generation`:
- Table batches: id, mode, provider, status, progress bar, requested, success, failed, createdBy, createdAt.
- Button "Quick Generate" → modal: provider, quantity, concurrency, retry, delay, proxy, dry run, auto activate.
- Button "Start Generation" → modal: provider, worker select, browser profile, headless, proxy pool, quantity, timeout.
- Click row → detail page.

`/dashboard/admin-generation/[id]`:
- Header batch info.
- Table jobs: id, status badge, currentStep, progress, worker, attempt, error, actions.
- Per-job expand: step log (decrypted), credential created (id, not plaintext).
- Buttons: Cancel batch, Retry job, Retry all failed.

### 6.9. Worker status widget (Overview dashboard)

Thêm vào `src/app/(dashboard)/dashboard/page.js`:
- Card: Workers (idle / busy / offline count).
- Card: Generation Success Rate (24h) = succeeded / total.
- Card: Queue Depth = pending jobs.

### 6.10. Persistence on restart

Khi Next.js process restart, in-process queue mất state. Để tránh mất job:
- Mỗi lần `enqueue` đã persist `status='queued'` vào DB.
- Khi boot, `src/shared/services/initializeApp.js` gọi `jobQueue.recoverPendingJobs()`:
  - Query tất cả `generationJobs` status ∈ {queued, running, waiting_*} mà batch chưa cancelled.
  - Reset `running` → `queued` (worker was the dead process).
  - Re-enqueue.

```js
export async function recoverPendingJobs() {
  const stuck = await jobsRepo.findStuck();
  for (const j of stuck) {
    await jobsRepo.update(j.id, { status: 'queued', currentStep: 'recovered' });
    jobQueue.enqueue(j.id);
  }
}
```

### 6.11. Audit

Mỗi `POST generation/quick`, `cancel`, `retry` → ghi `auditLog`.

## Acceptance criteria

1. Admin mở `/dashboard/admin-generation` → thấy table batches (ban đầu rỗng).
2. Submit Quick Generate batch provider=codex quantity=3 → tạo 1 batch + 3 jobs, status queued.
3. Trong vòng 30s (mock OAuth), 3 jobs chuyển sang succeeded, 3 credentials mới xuất hiện ở `providerCredentials` với status active.
4. Trong credential list, KHÔNG thấy plaintext; chỉ thấy `name, status, createdAt`.
5. Cancel batch đang chạy → jobs chuyển `cancelled`, batch `cancelled`.
6. Retry job failed → job `queued` lại, chạy lại.
7. Restart `npm run dev` giữa chừng → recover pending jobs, tất cả jobs vẫn complete đúng.
8. Worker offline > 90s → tự động đánh status `offline`.
9. `POST /<ADMIN_API_PREFIX>/generation/quick` ghi audit log `RUN_GENERATION`.
10. Test credential fail (giả lập 401) → job `failed`, KHÔNG lưu credential.
11. Client truy cập `/dashboard/admin-generation` → 404 (RBAC).
12. Client gọi `/<ADMIN_API_PREFIX>/generation/*` → 401 (no admin session).
13. **Không regress**: `/v1/chat/completions` vẫn phục vụ request bình thường khi queue đang chạy job (queue chạy async, không block event loop).

## Output artifacts

- `src/lib/db/repos/{generationBatchesRepo,generationJobsRepo,workersRepo}.js`
- Mở rộng `src/lib/db/schema.js`
- `src/lib/generation/{queue,quickGen,browserAdapter,workerRegistry,credentialTester,runner}.js`
- `src/app/api/_admin/generation/**/route.js`
- `src/app/api/_admin/workers/route.js` + `[id]/heartbeat/route.js`
- `src/app/(dashboard)/dashboard/admin-generation/page.js` + `[id]/page.js`
- Cập nhật `src/shared/services/initializeApp.js` → `recoverPendingJobs`
- Tests: `tests/generation/*.test.js` (queue logic, recovery, credential test mock)

## Backward compat

- 9Router OAuth handlers hiện tại (`src/app/api/oauth/[provider]/[action]/route.js`) vẫn hoạt động cho admin thủ công. Quick Generate adapter import internal function, không gọi qua HTTP.
- Không đụng `open-sse` core.
- Provider credentials cũ (tạo qua dashboard thủ công) vẫn hoạt động bình thường.
- Queue chạy trong cùng process Next.js; CPU-bound work (browser worker) sẽ tách process thật ở Phase 7+.
