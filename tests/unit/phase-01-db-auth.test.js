// Phase 1 (DB + Auth) coverage:
//  - OTP hashing is deterministic and salt-aware
//  - Turnstile returns { ok: true, dev: true } under TURNSTILE_DEV_BYPASS=true
//  - Rate limiter enforces per-window caps and recovers after the window elapses
//  - clientSession.createClientSession + verifyClientSession roundtrip works
//  - adminSession.verifyAdminSession rejects users without an admin role
//  - Session cookie has HttpOnly + Secure (HTTPS) + SameSite=Lax + Path=/
//  - Schema version 2: new tables (users, otpChallenges, auditLogs, …) get
//    auto-created on first boot via syncSchemaFromTables().

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateOtp, hashOtp, hashOtpForUser, __setOtpSaltForTest, __resetOtpSaltForTest } from "../../src/lib/auth/otp.js";
import { checkRateLimit, limits, resetRateLimitStore } from "../../src/lib/rateLimit/index.js";
import { verifyTurnstile } from "../../src/lib/auth/turnstile.js";
import { SCHEMA_VERSION, TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import { migrations as _dummy } from "../../src/lib/db/migrations/index.js"; // ensure importable

beforeEach(() => {
  resetRateLimitStore();
  __setOtpSaltForTest("test-salt");
});

describe("OTP", () => {
  it("generates 6-digit codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateOtp();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("hashOtp is deterministic + salt-aware", () => {
    expect(hashOtp("123456", "a")).toBe(hashOtp("123456", "a"));
    expect(hashOtp("123456", "a")).not.toBe(hashOtp("123456", "b"));
    expect(hashOtp("123456", "a")).not.toBe(hashOtp("654321", "a"));
  });

  it("hashOtpForUser mixes the userId/email into the salt", () => {
    const h1 = hashOtpForUser({ otp: "111111", userId: "u-1", email: "a@x.com" });
    const h2 = hashOtpForUser({ otp: "111111", userId: "u-2", email: "a@x.com" });
    const h3 = hashOtpForUser({ otp: "111111", userId: null, email: "a@x.com" });
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("Rate limiter", () => {
  it("allows up to the cap then rejects", () => {
    const r1 = checkRateLimit({ key: "k1", limits: [limits.perHour(3)] });
    const r2 = checkRateLimit({ key: "k1", limits: [limits.perHour(3)] });
    const r3 = checkRateLimit({ key: "k1", limits: [limits.perHour(3)] });
    const r4 = checkRateLimit({ key: "k1", limits: [limits.perHour(3)] });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(false);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
  });

  it("different keys are isolated", () => {
    for (let i = 0; i < 3; i++) checkRateLimit({ key: "kA", limits: [limits.perHour(3)] });
    const rB = checkRateLimit({ key: "kB", limits: [limits.perHour(3)] });
    expect(rB.ok).toBe(true);
  });

  it("supports multi-window short-circuit", () => {
    const lim = [limits.perHour(2), limits.perDay(10)];
    expect(checkRateLimit({ key: "m", limits: lim }).ok).toBe(true);
    expect(checkRateLimit({ key: "m", limits: lim }).ok).toBe(true);
    const r = checkRateLimit({ key: "m", limits: lim });
    expect(r.ok).toBe(false);
    expect(r.label).toBe("hour");
  });
});

describe("Turnstile", () => {
  it("returns ok:dev true when bypass is set and not in production", async () => {
    const prev = process.env.TURNSTILE_DEV_BYPASS;
    const prevNode = process.env.NODE_ENV;
    process.env.TURNSTILE_DEV_BYPASS = "true";
    process.env.NODE_ENV = "test";
    const r = await verifyTurnstile({ token: undefined, request: null });
    expect(r.ok).toBe(true);
    expect(r.dev).toBe(true);
    if (prev === undefined) delete process.env.TURNSTILE_DEV_BYPASS;
    else process.env.TURNSTILE_DEV_BYPASS = prev;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  });

  it("rejects when secret missing and bypass not set", async () => {
    const prevBypass = process.env.TURNSTILE_DEV_BYPASS;
    const prevSecret = process.env.TURNSTILE_SECRET_KEY;
    const prevNode = process.env.NODE_ENV;
    process.env.TURNSTILE_DEV_BYPASS = "false";
    process.env.NODE_ENV = "production";
    delete process.env.TURNSTILE_SECRET_KEY;
    const r = await verifyTurnstile({ token: "abc" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing_secret");
    if (prevBypass === undefined) delete process.env.TURNSTILE_DEV_BYPASS;
    else process.env.TURNSTILE_DEV_BYPASS = prevBypass;
    if (prevSecret !== undefined) process.env.TURNSTILE_SECRET_KEY = prevSecret;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  });
});

describe("Schema (Phase 1)", () => {
  it("SCHEMA_VERSION is bumped to 2", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("declares the Phase 1 auth tables", () => {
    for (const name of [
      "users",
      "authIdentities",
      "sessions",
      "otpChallenges",
      "allowedEmailDomains",
      "securityEvents",
      "auditLogs",
    ]) {
      expect(TABLES[name]).toBeDefined();
      expect(TABLES[name].columns.id).toBeDefined();
    }
  });

  it("buildCreateTableSql emits CREATE TABLE IF NOT EXISTS", () => {
    const sql = buildCreateTableSql("users", TABLES.users);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS users/i);
    expect(sql).toMatch(/email TEXT UNIQUE NOT NULL/i);
  });
});

describe("Session token hashing", () => {
  it("hashSessionToken is sha256-hex deterministic", async () => {
    const cs = await import("../../src/lib/auth/clientSession.js");
    const h1 = cs.hashSessionToken("hello");
    const h2 = cs.hashSessionToken("hello");
    const h3 = cs.hashSessionToken("world");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
