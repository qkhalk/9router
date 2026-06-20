// Phase 0 schema declaration — Client Portal + Admin Portal upgrade (DO NOT IMPORT YET)
//
// This file is a PURE DECLARATION. It mirrors the style of `src/lib/db/schema.js`
// but is intentionally NOT imported by any code path. It exists so that:
//   1. Phase 1 can review and finalize column types/indexes before touching the live schema.
//   2. Postgres adapter (when DATABASE_URL is set) can reuse the same shape.
//
// When Phase 1 begins, the table definitions here will be split into:
//   - Additive changes → merged into src/lib/db/schema.js TABLES + migrations/00X-*.js
//   - Postgres-only shapes → src/lib/db/schema.postgres.js (consumed by postgresAdapter)
//
// Conventions:
//   - TEXT PRIMARY KEY for UUID-style ids; INTEGER PRIMARY KEY AUTOINCREMENT for log tables.
//   - Timestamps stored as ISO-8601 TEXT (matches existing convention).
//   - Booleans stored as INTEGER 0/1 (matches existing convention).
//   - Encrypted payloads stored as JSON TEXT { encryptedPayload, iv, authTag, keyVersion }.
//   - All tables include createdAt; mutable tables also include updatedAt.
//
// STATUS: design-only. Review at Phase 1 start, then merge or split.

export const PHASE_0_TABLES = {
  // ─── Users / Auth ─────────────────────────────────────────────────────────
  users: {
    columns: {
      id: "TEXT PRIMARY KEY",
      email: "TEXT UNIQUE NOT NULL",
      username: "TEXT",
      passwordHash: "TEXT",
      role: "TEXT NOT NULL DEFAULT 'CLIENT'", // CLIENT | SUPER_ADMIN | ADMIN | SUPPORT | AUDITOR
      status: "TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'", // PENDING_VERIFICATION | ACTIVE | SUSPENDED | BANNED | DELETED
      emailVerifiedAt: "TEXT",
      lastLoginAt: "TEXT",
      mfaSecretEncrypted: "TEXT", // AES-256-GCM envelope
      mfaEnabled: "INTEGER NOT NULL DEFAULT 0",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)",
      "CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)",
      "CREATE INDEX IF NOT EXISTS idx_users_created ON users(createdAt DESC)",
    ],
  },

  authIdentities: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      provider: "TEXT NOT NULL", // google | password
      providerAccountId: "TEXT NOT NULL",
      providerEmail: "TEXT",
      emailVerified: "INTEGER NOT NULL DEFAULT 0",
      createdAt: "TEXT NOT NULL",
      lastLoginAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ai_user ON authIdentities(userId)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_provider_account ON authIdentities(provider, providerAccountId)",
    ],
  },

  sessions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      sessionType: "TEXT NOT NULL", // client | admin
      tokenHash: "TEXT NOT NULL",
      ipAddress: "TEXT",
      userAgent: "TEXT",
      expiresAt: "TEXT NOT NULL",
      revokedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(tokenHash)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_user_type ON sessions(userId, sessionType)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt)",
    ],
  },

  otpChallenges: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT",
      email: "TEXT NOT NULL",
      purpose: "TEXT NOT NULL", // EMAIL_REGISTRATION | EMAIL_LOGIN | PASSWORD_RESET | CHANGE_EMAIL | SENSITIVE_ACTION
      otpHash: "TEXT NOT NULL",
      attempts: "INTEGER NOT NULL DEFAULT 0",
      maxAttempts: "INTEGER NOT NULL DEFAULT 5",
      expiresAt: "TEXT NOT NULL",
      consumedAt: "TEXT",
      supersededAt: "TEXT", // when a newer OTP for the same purpose invalidates this one
      createdIp: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_otp_email_purpose ON otpChallenges(email, purpose, consumedAt)",
      "CREATE INDEX IF NOT EXISTS idx_otp_expires ON otpChallenges(expiresAt)",
    ],
  },

  allowedEmailDomains: {
    columns: {
      id: "TEXT PRIMARY KEY",
      domain: "TEXT UNIQUE NOT NULL",
      isEnabled: "INTEGER NOT NULL DEFAULT 1",
      createdBy: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_aed_enabled ON allowedEmailDomains(isEnabled)",
    ],
  },

  securityEvents: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT",
      eventType: "TEXT NOT NULL", // LOGIN_SUCCESS | LOGIN_FAIL | OTP_FAIL | TURNSTILE_FAIL | RATE_LIMIT_HIT | SUSPEND | BAN
      riskScore: "INTEGER DEFAULT 0",
      ipAddress: "TEXT",
      userAgent: "TEXT",
      ephemeralId: "TEXT",
      metadata: "TEXT", // JSON
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_se_user ON securityEvents(userId, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_se_event_type ON securityEvents(eventType, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_se_ip ON securityEvents(ipAddress, createdAt DESC)",
    ],
  },

  // ─── Gateway keys (client-facing; complement to existing apiKeys) ─────────
  gatewayKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL",
      name: "TEXT NOT NULL",
      keyPrefix: "TEXT NOT NULL",
      keyHash: "TEXT NOT NULL",
      lastFour: "TEXT NOT NULL",
      status: "TEXT NOT NULL DEFAULT 'active'", // active | revoked
      expiresAt: "TEXT",
      lastUsedAt: "TEXT",
      lastUsedIp: "TEXT",
      requestsPerMinute: "INTEGER",
      tokensPerDay: "INTEGER",
      tokensPerMonth: "INTEGER",
      createdAt: "TEXT NOT NULL",
      revokedAt: "TEXT",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_gk_hash ON gatewayKeys(keyHash)",
      "CREATE INDEX IF NOT EXISTS idx_gk_user ON gatewayKeys(userId, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_gk_status ON gatewayKeys(status)",
    ],
  },

  gatewayKeyModelPolicies: {
    columns: {
      gatewayKeyId: "TEXT NOT NULL",
      modelId: "TEXT NOT NULL",
      isAllowed: "INTEGER NOT NULL DEFAULT 1",
      maxTokens: "INTEGER",
    },
    primaryKey: "PRIMARY KEY (gatewayKeyId, modelId)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_gkmp_model ON gatewayKeyModelPolicies(modelId)",
    ],
  },

  // ─── Request logging ──────────────────────────────────────────────────────
  requestLogs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      requestId: "TEXT UNIQUE NOT NULL",
      userId: "TEXT",
      gatewayKeyId: "TEXT",
      endpoint: "TEXT NOT NULL",
      method: "TEXT NOT NULL",
      publicModel: "TEXT",
      resolvedModel: "TEXT",
      statusCode: "INTEGER NOT NULL DEFAULT 0",
      isStreaming: "INTEGER NOT NULL DEFAULT 0",
      finishReason: "TEXT",
      inputTokens: "INTEGER DEFAULT 0",
      outputTokens: "INTEGER DEFAULT 0",
      totalTokens: "INTEGER DEFAULT 0",
      latencyMs: "INTEGER",
      timeToFirstTokenMs: "INTEGER",
      retryCount: "INTEGER NOT NULL DEFAULT 0",
      fallbackCount: "INTEGER NOT NULL DEFAULT 0",
      selectedAttemptId: "TEXT",
      clientIp: "TEXT",
      country: "TEXT",
      userAgent: "TEXT",
      errorCode: "TEXT",
      errorMessage: "TEXT",
      startedAt: "TEXT NOT NULL",
      completedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rl_created ON requestLogs(createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rl_user_created ON requestLogs(userId, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rl_key_created ON requestLogs(gatewayKeyId, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rl_model_created ON requestLogs(publicModel, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rl_status ON requestLogs(statusCode)",
    ],
  },

  requestExchanges: {
    columns: {
      id: "TEXT PRIMARY KEY",
      requestLogId: "TEXT NOT NULL",
      clientRequestHeadersEncrypted: "TEXT",
      clientRequestBodyEncrypted: "TEXT",
      normalizedRequestBodyEncrypted: "TEXT",
      finalClientResponseHeadersEncrypted: "TEXT",
      finalClientResponseBodyEncrypted: "TEXT",
      systemPromptTextEncrypted: "TEXT",
      userPromptTextEncrypted: "TEXT",
      assistantResponseTextEncrypted: "TEXT",
      reasoningTextEncrypted: "TEXT",
      clientRequestSizeBytes: "INTEGER",
      clientResponseSizeBytes: "INTEGER",
      createdAt: "TEXT NOT NULL",
      expiresAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_re_request ON requestExchanges(requestLogId)",
      "CREATE INDEX IF NOT EXISTS idx_re_expires ON requestExchanges(expiresAt)",
    ],
  },

  requestAttempts: {
    columns: {
      id: "TEXT PRIMARY KEY",
      requestLogId: "TEXT NOT NULL",
      attemptNumber: "INTEGER NOT NULL",
      providerId: "TEXT",
      providerCredentialId: "TEXT",
      upstreamModel: "TEXT",
      upstreamEndpoint: "TEXT",
      upstreamRequestHeadersEncrypted: "TEXT",
      upstreamRequestBodyEncrypted: "TEXT",
      upstreamResponseHeadersEncrypted: "TEXT",
      upstreamResponseBodyEncrypted: "TEXT",
      statusCode: "INTEGER",
      errorCode: "TEXT",
      errorMessage: "TEXT",
      inputTokens: "INTEGER DEFAULT 0",
      outputTokens: "INTEGER DEFAULT 0",
      latencyMs: "INTEGER",
      timeToFirstTokenMs: "INTEGER",
      chunkCount: "INTEGER DEFAULT 0",
      wasSelected: "INTEGER NOT NULL DEFAULT 0",
      startedAt: "TEXT NOT NULL",
      completedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ra_log_attempt ON requestAttempts(requestLogId, attemptNumber)",
    ],
  },

  toolCallLogs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      requestLogId: "TEXT NOT NULL",
      requestAttemptId: "TEXT",
      toolCallId: "TEXT",
      toolName: "TEXT",
      toolArgumentsEncrypted: "TEXT",
      toolResultEncrypted: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_tcl_request ON toolCallLogs(requestLogId)",
    ],
  },

  requestAttachments: {
    columns: {
      id: "TEXT PRIMARY KEY",
      requestLogId: "TEXT NOT NULL",
      type: "TEXT",
      mimeType: "TEXT",
      sizeBytes: "INTEGER",
      storageKey: "TEXT",
      sha256: "TEXT",
      createdAt: "TEXT NOT NULL",
      expiresAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ra_req ON requestAttachments(requestLogId)",
      "CREATE INDEX IF NOT EXISTS idx_ra_expires ON requestAttachments(expiresAt)",
    ],
  },

  usageDaily: {
    columns: {
      date: "TEXT NOT NULL", // YYYY-MM-DD (local or UTC)
      userId: "TEXT NOT NULL",
      gatewayKeyId: "TEXT",
      publicModel: "TEXT NOT NULL",
      requestCount: "INTEGER NOT NULL DEFAULT 0",
      successCount: "INTEGER NOT NULL DEFAULT 0",
      errorCount: "INTEGER NOT NULL DEFAULT 0",
      inputTokens: "INTEGER NOT NULL DEFAULT 0",
      outputTokens: "INTEGER NOT NULL DEFAULT 0",
      estimatedCost: "REAL NOT NULL DEFAULT 0",
    },
    primaryKey: "PRIMARY KEY (date, userId, gatewayKeyId, publicModel)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ud_user_date ON usageDaily(userId, date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_ud_model_date ON usageDaily(publicModel, date DESC)",
    ],
  },

  // ─── Generation ───────────────────────────────────────────────────────────
  generationBatches: {
    columns: {
      id: "TEXT PRIMARY KEY",
      mode: "TEXT NOT NULL", // quick | browser
      providerId: "TEXT NOT NULL",
      requestedCount: "INTEGER NOT NULL",
      successCount: "INTEGER NOT NULL DEFAULT 0",
      failedCount: "INTEGER NOT NULL DEFAULT 0",
      status: "TEXT NOT NULL DEFAULT 'queued'", // queued | running | paused | completed | cancelled | failed
      createdBy: "TEXT NOT NULL",
      configEncrypted: "TEXT",
      startedAt: "TEXT",
      completedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_gb_status ON generationBatches(status, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_gb_created_by ON generationBatches(createdBy, createdAt DESC)",
    ],
  },

  generationJobs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      batchId: "TEXT NOT NULL",
      status: "TEXT NOT NULL DEFAULT 'queued'", // queued | running | waiting_email | waiting_otp | waiting_manual_action | retrying | succeeded | partially_succeeded | failed | cancelled
      currentStep: "TEXT",
      progress: "INTEGER NOT NULL DEFAULT 0",
      workerId: "TEXT",
      attempt: "INTEGER NOT NULL DEFAULT 1",
      email: "TEXT",
      username: "TEXT",
      resultCredentialId: "TEXT",
      errorCode: "TEXT",
      errorMessage: "TEXT",
      errorStackEncrypted: "TEXT",
      startedAt: "TEXT",
      completedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_gj_batch ON generationJobs(batchId, status)",
      "CREATE INDEX IF NOT EXISTS idx_gj_status_created ON generationJobs(status, createdAt)",
    ],
  },

  workers: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      mode: "TEXT NOT NULL", // quick | browser
      status: "TEXT NOT NULL DEFAULT 'idle'", // idle | busy | offline | error
      version: "TEXT",
      lastHeartbeatAt: "TEXT",
      activeJobs: "INTEGER NOT NULL DEFAULT 0",
      capacity: "INTEGER NOT NULL DEFAULT 1",
      configEncrypted: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_w_status_heartbeat ON workers(status, lastHeartbeatAt)",
    ],
  },

  // ─── Audit ────────────────────────────────────────────────────────────────
  auditLogs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      actorUserId: "TEXT",
      action: "TEXT NOT NULL", // e.g. VIEW_REQUEST_CONTENT, RUN_GENERATION, CHANGE_DOMAIN_ALLOWLIST
      entityType: "TEXT",
      entityId: "TEXT",
      beforeData: "TEXT", // JSON
      afterData: "TEXT", // JSON
      ipAddress: "TEXT",
      userAgent: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_al_actor ON auditLogs(actorUserId, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_al_action ON auditLogs(action, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_al_entity ON auditLogs(entityType, entityId)",
    ],
  },
};

// Phase 1 note: when merging into src/lib/db/schema.js, the helper
// `buildCreateTableSql(name, def)` already supports `primaryKey` field.
// No changes required to the build helper.
