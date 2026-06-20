# Phase 8 — Testing & Release

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Bộ test toàn diện (unit + integration + E2E + load) cover mọi acceptance criteria từ Phase 1–7, đảm bảo release an toàn. Hoàn thiện production documentation, runbook, migration guide.

## Phạm vi

**Trong scope:**
- Unit tests: domain, OTP hash, key generation, redaction, encryption, quota, RBAC.
- Integration tests: full request lifecycle với mock provider; auth flow (register → verify → login → key create → call API); generation batch happy path; retention.
- RBAC tests: client không truy cập admin path, admin không xem client activity raw, role-based filter.
- Streaming tests: chunk accumulation, reconstruction correctness, large body (>1MB).
- Logging tests: encryption roundtrip, redaction coverage, retention deletion, audit log.
- Failover tests: combo fallback + account fallback + retry; từng attempt phải có row.
- Load tests: k6 scripts cho `/v1/chat/completions` với 100 RPS, 1000 RPS.
- Migration tests: SQLite → PostgreSQL migration script correctness.
- Production documentation: `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/MIGRATION-GUIDE.md`, `docs/API-REFERENCE.md`.
- CHANGELOG cập nhật.
- Release notes theo semantic version.

**Ngoài scope:**
- Penetration test chuyên nghiệp (Phase 9+, out of MVP).
- Bug bounty program.

## Tasks

### 8.1. Unit tests

`tests/unit/` (vitest):
- `tests/unit/domain-allowlist.test.js` — exact match, normalize, edge cases (`GMAIL.COM`, `gmail.com.xyz`, `fakegmail.com`).
- `tests/unit/otp.test.js` — generate, hash, verify, expire, attempts, supersede.
- `tests/unit/gateway-key.test.js` — generate, hash, verify, rotate.
- `tests/unit/redaction.test.js` — headers, body, common token patterns.
- `tests/unit/encryption.test.js` — AES-256-GCM roundtrip, dual-key, wrong key version throws.
- `tests/unit/quota.test.js` — rpm, tpd, tpm bucket logic, sliding window.
- `tests/unit/rbac.test.js` — role-based filter, 404 for insufficient role.
- `tests/unit/request-log.test.js` — orchestrator state machine, finalize idempotent.

### 8.2. Integration tests

`tests/integration/`:
- `tests/integration/auth-flow.test.js` — register email → OTP verify → login → session → logout.
- `tests/integration/google-oauth-mock.test.js` — mock Google token endpoint, verify email_verified=false reject.
- `tests/integration/turnstile.test.js` — mock Cloudflare siteverify, Fail-Closed ở prod.
- `tests/integration/key-lifecycle.test.js` — create key → call /v1 → revoke → call again 401.
- `tests/integration/quota-enforcement.test.js` — create key rpm=1 → 2nd request 429.
- `tests/integration/model-permission.test.js` — call ungranted model → 403.
- `tests/integration/request-lifecycle.test.js` — full flow: client request → log → upstream call → response → log.
- `tests/integration/streaming-reconstruction.test.js` — 10 chunks SSE → reconstructed text correct.
- `tests/integration/retry-fallback.test.js` — provider A 500 → fallback provider B 200 → 2 attempt rows.
- `tests/integration/retention.test.js` — set retention 1d, mock old rows, run cron, assert deleted.
- `tests/integration/generation-batch.test.js` — mock OAuth → 3 jobs succeed → credentials created.
- `tests/integration/audit-log.test.js` — every sensitive action writes audit row.

### 8.3. E2E tests (Playwright)

`tests/e2e/`:
- `tests/e2e/client-register-login.spec.js` — full UI flow: register → verify OTP (mock) → land on dashboard.
- `tests/e2e/client-create-key.spec.js` — UI create key → modal show plaintext once → reload no plaintext.
- `tests/e2e/client-activity.spec.js` — UI activity page chỉ show time + model, không có prompt/response trong DOM.
- `tests/e2e/admin-users.spec.js` — admin list users, suspend, verify revoked keys.
- `tests/e2e/admin-credentials.spec.js` — admin create credential, no plaintext in list view.
- `tests/e2e/admin-requests-detail.spec.js` — admin view request, all 4 layers decrypted in tabs.
- `tests/e2e/admin-generation.spec.js` — admin create quick gen batch, watch progress, cancel mid-way.

### 8.4. Load tests (k6)

`tests/load/`:
- `tests/load/gateway-smoke.js` — 100 RPS, 1 min, p95 < 500ms.
- `tests/load/gateway-stress.js` — 1000 RPS, 5 min, p95 < 2s, error rate < 1%.
- `tests/load/admin-api.js` — admin endpoints under load.
- `tests/load/logging-overhead.js` — compare latency with/without logging layer, target overhead < 50ms p95.

```js
// tests/load/gateway-smoke.js (k6)
import http from 'k6/http';
import { check } from 'k6';

export const options = { vus: 50, duration: '1m' };

export default function () {
  const res = http.post(`${__ENV.BASE_URL}/v1/chat/completions`, JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  }), { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${__ENV.SK_KEY}` } });
  check(res, { 'status 200': r => r.status === 200 });
}
```

### 8.5. Migration tests

`tests/migration/`:
- `tests/migration/sqlite-to-postgres.test.js` — generate fake SQLite DB with 1000 rows, run migration, assert all rows in Postgres, assert IDs preserved.
- `tests/migration/db-json-to-sqlite.test.js` — generate fake `db.json` (legacy), migrate to SQLite, verify.

### 8.6. Test infrastructure

- `tests/setup/global-setup.js` — chuẩn bị test DB (SQLite in-memory), seed minimal data.
- `tests/setup/global-teardown.js` — cleanup.
- `tests/helpers/mockProvider.js` — mock HTTP server simulating OpenAI/Anthropic/Codex.
- `tests/helpers/mockCloudflare.js` — mock siteverify.
- `tests/helpers/mockGoogle.js` — mock Google OAuth + JWKS.
- `tests/helpers/mockSmtp.js` — capture sent emails.
- `vitest.config.js` cập nhật: parallel, coverage thresholds (80% lines, 70% branches).
- `playwright.config.js` (NEW) — base URL, screenshot on failure, video on failure.

### 8.7. CI workflow

`.github/workflows/test.yml`:
```yaml
name: Tests
on: [push, pull_request]
jobs:
  unit-integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_DB: 9router_test, POSTGRES_USER: test, POSTGRES_PASSWORD: test }
      redis:
        image: redis:7
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
  load:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run dev &
      - run: npx k6 run tests/load/gateway-smoke.js
```

### 8.8. Production documentation

`docs/DEPLOYMENT.md`:
- Quick start (Docker Compose).
- Manual install (systemd + Postgres + Redis + Caddy).
- Env contract (full list with descriptions).
- TLS setup.
- Cloudflare Access setup (step-by-step with screenshots).
- Backup & restore runbook.
- Upgrade procedure.

`docs/OPERATIONS.md`:
- Health check endpoints.
- Metrics endpoint + PromQL query examples.
- Common runbooks (rotate encryption key, ban user, revoke all keys, drain queue, scale workers).
- Log location + grep recipes.
- Alert response procedures.

`docs/MIGRATION-GUIDE.md`:
- Upgrading from 9Router v0.5.x to v1.0.0.
- Schema migration steps.
- Env additions.
- Cookie migration.
- Admin user migration.
- Rollback procedure.

`docs/API-REFERENCE.md`:
- Full Client API + Admin API + Webhook reference (auto-generated từ OpenAPI spec).
- OpenAPI spec ở `docs/openapi.json` (generate từ route handlers qua `next-openapi` hoặc tương tự).

### 8.9. CHANGELOG

`CHANGELOG.md` thêm section v1.0.0:
```
## [1.0.0] - 2026-XX-XX

### Added
- Client Portal (Google + Email/Password + OTP, Turnstile).
- Admin Portal (Users, API Keys, Providers, Credentials, Models, Combos, Generation, Request Logs, Audit).
- API key format `sk-<base64url 32-byte>` (separate from internal `apiKeys`).
- Full request logging (4 layers, AES-256-GCM encrypted, redaction).
- Quick Generate + Start Generation (in-process queue MVP).
- TOTP MFA for admin.
- Cloudflare Access integration.
- Encryption key rotation.
- Retention policy + cron.
- Prometheus metrics endpoint.
- Backup script.
- Docker Compose with Postgres + Redis + Caddy.

### Security
- Client and admin session cookies separated.
- Private admin path via env random.
- OTP never stored in plaintext.
- Logging secrets redaction.
- AES-256-GCM encryption for prompt/response/raw payloads.
- 404 instead of 403 for invalid admin path (anti-enumeration).
- Audit log for sensitive admin actions.

### Backward compatibility
- Existing dashboard password (`auth_token` cookie) still works.
- Internal `apiKeys` table preserved.
- `open-sse` core routing untouched.
- SQLite still default for dev; Postgres optional via `DATABASE_URL`.
```

### 8.10. Release artifacts

- Tag `v1.0.0` trong git.
- Docker image push lên GHCR: `ghcr.io/9router/9router:1.0.0`.
- CLI package bump version tương ứng.
- Migration guide link trong release notes.

## Acceptance criteria

1. `npm run test:unit` — 100% pass, coverage ≥ 80% lines, ≥ 70% branches.
2. `npm run test:integration` — 100% pass.
3. `npm run test:e2e` — 100% pass trên chromium, firefox, webkit.
4. `npm run test:load` (gateway-smoke) — p95 < 500ms, error rate < 0.1%.
5. `npm run test:logging-overhead` — overhead p95 < 50ms.
6. `tests/migration/sqlite-to-postgres.test.js` — 1000 rows migrated, data integrity check pass.
7. CI workflow chạy xanh trên PR.
8. `docs/DEPLOYMENT.md` cover 3 scenarios: Docker Compose, manual, cloud (Cloudflare).
9. `docs/OPERATIONS.md` cover ít nhất 10 runbook phổ biến.
10. `docs/API-REFERENCE.md` mô tả 100% endpoint mới.
11. `CHANGELOG.md` có entry v1.0.0 với full list.
12. **Không regress**: tất cả test cũ của 9Router (`tests/`) vẫn pass. Cụ thể `tests/unit/`, `tests/translator/`, `tests/__baseline__/`.
13. `npm audit` — 0 high/critical.
14. Bundle size: client portal + admin portal bundles vẫn tách biệt (verify qua `next build` output + check `__Secure-admin_session` KHÔNG xuất hiện trong `(client)` chunks).

## Output artifacts

- `tests/unit/**/*.test.js` (~20 files)
- `tests/integration/**/*.test.js` (~15 files)
- `tests/e2e/**/*.spec.js` (~7 files)
- `tests/load/*.js` (~4 k6 scripts)
- `tests/migration/**/*.test.js` (~2 files)
- `tests/setup/*.js`
- `tests/helpers/*.js`
- `playwright.config.js`
- `.github/workflows/test.yml`
- `docs/DEPLOYMENT.md`
- `docs/OPERATIONS.md`
- `docs/MIGRATION-GUIDE.md`
- `docs/API-REFERENCE.md`
- `docs/openapi.json` (generated)
- `CHANGELOG.md` updated
- Tag `v1.0.0`

## Backward compat

- Giữ nguyên tất cả test cũ của 9Router (translator, combo, baseline).
- Test mới chỉ cover phần mới, không overwrite test cũ.
- Migrations KHÔNG drop data cũ; chỉ ADD tables/columns.
