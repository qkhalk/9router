// In-memory sliding-window rate limiter. Phase 7 will swap this for a Redis
// backend; for now we keep a per-key Map. Per-process state means the limit
// resets on restart and is per-instance — fine for single-node dev/prod and
// trivial to swap for a shared store later.
const DEFAULT_WINDOW_MS = 60 * 1000;

const buckets = new Map(); // key -> Array<number epochMs>

function prune(arr, cutoff) {
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

export function resetRateLimitStore() {
  buckets.clear();
}

function consume(key, max, windowMs = DEFAULT_WINDOW_MS, now = Date.now()) {
  const arr = buckets.get(key) || [];
  prune(arr, now - windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    const oldest = arr[0];
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, oldest + windowMs - now) };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, remaining: Math.max(0, max - arr.length), retryAfterMs: 0 };
}

// Hit multiple limits in order; the first failure short-circuits so the
// caller learns the most-restrictive limit that was exceeded.
export function checkRateLimit({ key, limits, now = Date.now() } = {}) {
  if (!key) throw new Error("rate limit key is required");
  if (!Array.isArray(limits) || limits.length === 0) {
    return { ok: true };
  }
  for (const { max, windowMs, label } of limits) {
    const r = consume(`${key}|${label || windowMs}`, max, windowMs, now);
    if (!r.ok) {
      return { ok: false, label: label || `${windowMs}ms`, retryAfterMs: r.retryAfterMs, remaining: r.remaining };
    }
  }
  return { ok: true };
}

// Convenience wrapper for the "per hour / per day" patterns the auth routes
// use. Limits is a list of { max, windowMs, label }.
export const limits = {
  perHour: (max) => ({ max, windowMs: 60 * 60 * 1000, label: "hour" }),
  perDay: (max) => ({ max, windowMs: 24 * 60 * 60 * 1000, label: "day" }),
  perMinute: (max) => ({ max, windowMs: 60 * 1000, label: "minute" }),
  perWindow: (max, windowMs, label) => ({ max, windowMs, label: label || `${windowMs}ms` }),
};
