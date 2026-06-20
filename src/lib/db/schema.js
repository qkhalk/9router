// Latest schema version — bumped when a migration is added in ./migrations/
export const SCHEMA_VERSION = 2;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },

  // ─── Phase 1: Client Portal + Admin Portal (auth, OTP, RBAC, audit) ─────
  // Additive only — syncSchemaFromTables() creates them on first boot.
  users: {
    columns: {
      id: "TEXT PRIMARY KEY",
      email: "TEXT UNIQUE NOT NULL",
      username: "TEXT",
      passwordHash: "TEXT",
      role: "TEXT NOT NULL DEFAULT 'CLIENT'",
      status: "TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'",
      emailVerifiedAt: "TEXT",
      lastLoginAt: "TEXT",
      mfaSecretEncrypted: "TEXT",
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
      provider: "TEXT NOT NULL",
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
      sessionType: "TEXT NOT NULL",
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
      purpose: "TEXT NOT NULL",
      otpHash: "TEXT NOT NULL",
      attempts: "INTEGER NOT NULL DEFAULT 0",
      maxAttempts: "INTEGER NOT NULL DEFAULT 5",
      expiresAt: "TEXT NOT NULL",
      consumedAt: "TEXT",
      supersededAt: "TEXT",
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
      eventType: "TEXT NOT NULL",
      riskScore: "INTEGER DEFAULT 0",
      ipAddress: "TEXT",
      userAgent: "TEXT",
      ephemeralId: "TEXT",
      metadata: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_se_user ON securityEvents(userId, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_se_event_type ON securityEvents(eventType, createdAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_se_ip ON securityEvents(ipAddress, createdAt DESC)",
    ],
  },

  auditLogs: {
    columns: {
      id: "TEXT PRIMARY KEY",
      actorUserId: "TEXT",
      action: "TEXT NOT NULL",
      entityType: "TEXT",
      entityId: "TEXT",
      beforeData: "TEXT",
      afterData: "TEXT",
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

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
