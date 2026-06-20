# Phase 7 — Security & Production

_Parent: [9router-upgrade.md](../9router-upgrade.md) · Status: design_

## Mục tiêu

Nâng cấp security lên production-ready: MFA/TOTP cho admin, Cloudflare Access cho admin path, key rotation, backup, retention thật (cron), metrics & alerting, Docker Compose đầy đủ, security review checklist.

## Phạm vi

**Trong scope:**
- `src/lib/admin/mfa.js` — TOTP setup (secret generate QR, verify code).
- Admin MFA enforcement cho admin session + re-auth cho sensitive actions.
- Cloudflare Access integration: JWT validation middleware `src/lib/admin/cloudflareAccess.js`.
- Encryption key rotation: thêm table `encryptionKeys`, generate new version, retire old, dual-key decrypt.
- Backup script: `scripts/backup.sh` zip DATA_DIR + upload S3/MinIO.
- Cron retention thật (đã có từ Phase 5, ở đây thêm metrics + alert).
- Metrics: `src/lib/metrics/prom.js` Prometheus exposition format endpoint `/api/_admin/metrics`.
- Alerting rules doc: `docs/ALERTING.md` (không tích hợp PagerDuty/Slack ở MVP, chỉ document).
- Docker Compose: `docker-compose.yml` thêm postgres, redis, caddy reverse proxy.
- Security review checklist: `docs/SECURITY-CHECKLIST.md`.
- Nginx/Caddy config mẫu: `deploy/caddy/Caddyfile`, `deploy/nginx/9router.conf`.

**Ngoài scope:**
- SIEM integration.
- Intrusion detection.
- DDoS mitigation (Cloudflare handles).

## Tasks

### 7.1. MFA/TOTP cho admin

```js
// src/lib/admin/mfa.js
import { authenticator } from 'otplib';
import qrcode from 'qrcode';

export function generateMfaSecret(email) {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(email, '9Router', secret);
  return { secret, otpauth };
}

export async function enableMfa(userId) {
  const user = await usersRepo.findById(userId);
  const { secret, otpauth } = generateMfaSecret(user.email);
  await usersRepo.update(userId, { mfaSecretEncrypted: encryptField(secret) });
  const qrDataUrl = await qrcode.toDataURL(otpauth);
  return { secret, qrDataUrl };
}

export function verifyMfaCode(userId, code) {
  const user = await usersRepo.findById(userId);
  const secret = decryptField(user.mfaSecretEncrypted);
  if (!secret) return false;
  return authenticator.verify({ token: code, secret });
}
```

Luồng admin login:
1. Password OK → check `user.mfaEnabled`.
2. Nếu enabled → response `{ requiresMfa: true, mfaToken: <short-lived JWT scope=mfa> }`.
3. Client gọi `POST /api/auth/admin/verify-mfa { mfaToken, code }` → set `__Secure-admin_session`.

Sensitive actions (revoke all keys, change retention, rotate encryption key, disable user, view raw credential) yêu cầu `reAuth=true` trong 5 phút gần nhất.

### 7.2. Cloudflare Access

```js
// src/lib/admin/cloudflareAccess.js
import { jwtVerify, createRemoteJWKSet } from 'jose';

const CERTS_URL = process.env.CF_ACCESS_TEAM_DOMAIN
  ? `https://${process.env.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`
  : null;
const AUD = process.env.CF_ACCESS_AUD;
const jwks = CERTS_URL ? createRemoteJWKSet(new URL(CERTS_URL)) : null;

export async function verifyCloudflareAccessJwt(jwt) {
  if (!jwks || !jwt) return null;
  try {
    const { payload } = await jwtVerify(jwt, jwks, { audience: AUD });
    return { email: payload.email, sub: payload.sub };
  } catch {
    return null;
  }
}
```

Middleware trong `src/proxy.js` cho path `/<ADMIN_PATH_PREFIX>/*`:
- Nếu header `Cf-Access-Jwt-Assertion` tồn tại → verify → nếu OK + email match admin allowlist → cho qua + auto-issue `__Secure-admin_session`.
- Nếu không có JWT + không có session admin → 404.

Email allowlist lưu `settings.adminEmails: []`.

### 7.3. Encryption key rotation

```js
// src/lib/crypto/aesGcm.js
const KEYS = new Map(); // version → Buffer

export function loadKeys() {
  const currentVersion = parseInt(process.env.ENCRYPTION_KEY_VERSION || '1', 10);
  for (let v = 1; v <= currentVersion; v++) {
    const k = process.env[`ENCRYPTION_KEY_V${v}`];
    if (k) KEYS.set(v, Buffer.from(k, 'base64'));
  }
}

export function encryptAesGcm(plaintext, version) {
  const key = KEYS.get(version || KEYS.size);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encryptedPayload: enc.toString('base64'), iv: iv.toString('base64'), authTag: tag.toString('base64'), keyVersion: version || KEYS.size };
}

export function decryptAesGcm({ encryptedPayload, iv, authTag, keyVersion }) {
  const key = KEYS.get(keyVersion);
  if (!key) throw new Error(`unknown key version ${keyVersion}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encryptedPayload, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}
```

API: `POST /<ADMIN_API_PREFIX>/settings/rotate-encryption-key` → generate new 32-byte base64 → set `ENCRYPTION_KEY_V{N+1}` env (ghi vào `.env.local` hoặc trả về cho admin copy thủ công).

Background re-encrypt task: `src/lib/retention/reEncrypt.js` chạy mỗi 24h, re-encrypt tất cả rows từ version cũ sang version mới (giới hạn batch 1000 rows/lần).

### 7.4. Backup

`scripts/backup.sh`:
```bash
#!/bin/bash
DATA_DIR="${DATA_DIR:-/var/lib/9router}"
TS=$(date +%Y%m%d_%H%M%S)
BACKUP="${DATA_DIR}/backups/9router_${TS}.tar.gz"
mkdir -p "${DATA_DIR}/backups"
tar -czf "$BACKUP" -C "$DATA_DIR" \
  --exclude='backups' \
  --exclude='*.log' \
  --exclude='logs/*' \
  db.json db.sqlite usage.json
echo "Backup: $BACKUP"
# Optional: upload to S3 if BACKUP_S3_BUCKET set
if [ -n "$BACKUP_S3_BUCKET" ]; then
  aws s3 cp "$BACKUP" "s3://${BACKUP_S3_BUCKET}/9router/${TS}.tar.gz"
fi
```

Crontab: `0 */6 * * * /opt/9router/scripts/backup.sh`.

Restore: `scripts/restore.sh <backup.tar.gz>` → stop server, decompress, restart.

### 7.5. Retention cron thật

Phase 5 đã có `src/lib/retention/purge.js`. Phase 7:
- Wire vào `src/shared/services/initializeApp.js` với `setInterval(runRetention, 6 * 3600 * 1000)`.
- Log số rows đã xóa vào metrics.

### 7.6. Metrics (Prometheus exposition)

`src/lib/metrics/prom.js`:
```js
const counters = new Map();
const histograms = new Map();

export function inc(name, labels = {}) {
  const k = metricKey(name, labels);
  counters.set(k, (counters.get(k) || 0) + 1);
}

export function observe(name, value, labels = {}) {
  const k = metricKey(name, labels);
  if (!histograms.has(k)) histograms.set(k, []);
  const arr = histograms.get(k);
  arr.push(value);
  if (arr.length > 10000) arr.shift();
}

export function expose() {
  const lines = [];
  for (const [k, v] of counters) lines.push(`${k} ${v}`);
  for (const [k, arr] of histograms) {
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
    lines.push(`${k}_p50 ${p50}`);
    lines.push(`${k}_p95 ${p95}`);
    lines.push(`${k}_p99 ${p99}`);
  }
  return lines.join('\n');
}
```

Mount ở `/api/_admin/metrics` (chỉ admin hoặc scrape token).

Metrics instrument:
- `http_requests_total{method,path,status}`.
- `request_logging_duration_ms`.
- `openai_upstream_duration_ms{provider,model}`.
- `gateway_quota_exceeded_total{user_id}`.
- `generation_jobs_total{status}`.

### 7.7. Alerting doc

`docs/ALERTING.md` document Prometheus alert rules:
- Error rate > 5% trong 5 phút.
- P95 latency > 10s.
- Queue depth > 100.
- Worker offline > 5 phút.
- Disk usage > 80%.
- Failed login > 50/phút.

### 7.8. Docker Compose

`docker-compose.yml`:
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: 9router
      POSTGRES_USER: 9router
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
  app:
    build: .
    environment:
      DATABASE_URL: postgres://9router@postgres:5432/9router
      REDIS_URL: redis://redis:6379
      ADMIN_PATH_PREFIX: ${ADMIN_PATH_PREFIX}
      ADMIN_API_PREFIX: ${ADMIN_API_PREFIX}
    depends_on: [postgres, redis]
  caddy:
    image: caddy:2
    volumes:
      - ./deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    ports: ["80:80", "443:443"]
    depends_on: [app]
volumes:
  pgdata:
  caddy_data:
```

`deploy/caddy/Caddyfile`:
```
router.example.com {
  reverse_proxy app:20128
  encode zstd gzip
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }
  @admin path /_ops_* /_internal_*
  header @admin X-Frame-Options "DENY"
  header @admin Cache-Control "no-store"
  @api path /v1/*
  rate_limit @api 100r/m
}
```

### 7.9. Security review checklist

`docs/SECURITY-CHECKLIST.md`:
- [ ] `JWT_SECRET` random 32+ byte.
- [ ] `INITIAL_PASSWORD` đã đổi.
- [ ] `ENCRYPTION_KEY_V1` random 32 byte base64.
- [ ] `TURNSTILE_SECRET_KEY` set, Fail-Closed.
- [ ] `GOOGLE_CLIENT_SECRET` set.
- [ ] `SMTP_PASS` dùng app password.
- [ ] Cloudflare Access bật cho admin path.
- [ ] Admin MFA enabled cho tất cả admin user.
- [ ] Backup script chạy mỗi 6h.
- [ ] Retention policy đã set.
- [ ] `auth_token` legacy đã migrate admin user sang `users.role=ADMIN`.
- [ ] Default password đã xóa khỏi DB (`settings.password` không còn default `123456`).
- [ ] Audit log ghi đủ các action quan trọng.
- [ ] Logging redaction test pass (unit test).
- [ ] `npm audit` không có high/critical vulnerability.

## Acceptance criteria

1. Admin user bật MFA → login lần sau phải nhập OTP từ authenticator app.
2. Sai OTP 5 lần → account tạm khóa 15 phút.
3. Re-auth cho sensitive action (revoke all keys) yêu cầu password lại trong 5 phút.
4. Cloudflare Access JWT hợp lệ + email admin → vào `/<ADMIN_PATH_PREFIX>` không cần session.
5. Cloudflare Access JWT không hợp lệ → 404.
6. Rotate encryption key V1→V2 → encryptions mới dùng V2, decryptions cũ V1 vẫn đọc được.
7. Re-encrypt background: sau 24h, 100% rows cũ đã migrate sang V2.
8. Backup script chạy → file `.tar.gz` xuất hiện trong `${DATA_DIR}/backups/`.
9. `GET /api/_admin/metrics` (với admin session) → text/plain Prometheus format.
10. Caddy config mẫu deploy được local (skip DNS, dùng `tls internal`).
11. `docker-compose up -d` → tất cả service lên, app health check pass.
12. Security checklist đủ 15 items.

## Output artifacts

- `src/lib/admin/{mfa,cloudflareAccess}.js`
- `src/lib/crypto/aesGcm.js` (dual-key)
- `src/lib/retention/reEncrypt.js`
- `src/lib/metrics/prom.js`
- `src/app/api/_admin/metrics/route.js`
- `src/app/api/auth/admin/verify-mfa/route.js`
- `scripts/backup.sh` + `scripts/restore.sh`
- `deploy/caddy/Caddyfile`
- `deploy/nginx/9router.conf`
- `docker-compose.yml` + `Dockerfile` updates
- `docs/SECURITY-CHECKLIST.md`
- `docs/ALERTING.md`
- Tests: `tests/security/*.test.js` (MFA, redaction, encryption key rotation, re-auth)

## Backward compat

- Admin không bật MFA vẫn login được (deprecation warning + nag admin settings page).
- Encryption key V1 mặc định từ env; nếu không có → tự generate lần đầu và lưu vào `DATA_DIR/encryption-key-v1` (mode 0600) — tương tự JWT secret fallback hiện tại.
- Docker Compose là optional; standalone install giữ nguyên.
