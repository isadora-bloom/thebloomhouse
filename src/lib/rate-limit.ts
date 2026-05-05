/**
 * Durable rate limiter (PROJECT-AUDIT-V2 BUG-12).
 *
 * Replaces the in-memory Map-based limiters that survived a single
 * serverless instance only — under Vercel each function instance had its
 * own Map and horizontal scale defeated the limit entirely.
 *
 * Backed by Postgres (table `rate_limit_buckets`, RPC `check_rate_limit`,
 * migration 208). Sliding window: each key keeps a jsonb array of unix-
 * second timestamps; the RPC evicts entries outside the window then
 * conditionally appends `now()` if the in-window count is under limit.
 *
 * Public API:
 *
 *   const rl = await checkRateLimit({ key: 'sage:abc', limit: 30, windowSec: 60 })
 *   if (!rl.ok) return 429 with Retry-After: secondsUntil(rl.resetAt)
 *
 * Failure mode: when Postgres is unreachable we use an in-memory token
 * bucket as a hard floor (limit/4 per window*4) rather than failing open.
 * A circuit breaker tracks consecutive Postgres failures and short-circuits
 * after 3 consecutive errors, skipping Postgres entirely for 60 seconds.
 * This prevents an unbounded AI spend window during Supabase blips.
 *
 * Key namespace guard: any key containing ':shared' is rejected at call
 * time — callers must use per-venue keys (e.g. 'sage:<weddingId>').
 *
 * Same code path local + prod — no NODE_ENV branches.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { redactError } from '@/lib/observability/redact'
import { recordCounter } from '@/lib/observability/metrics'

export interface RateLimitInput {
  /**
   * Limiter key. Caller's responsibility to namespace
   * (e.g. `'sage:<weddingId>'`, `'nlq:<userId>'`).
   * Keys containing ':shared' are forbidden — use per-venue keys.
   */
  key: string
  /** Max hits allowed per window. */
  limit: number
  /** Window length in seconds. */
  windowSec: number
}

export interface RateLimitResult {
  /** true = caller may proceed. false = 429. */
  ok: boolean
  /** Hits remaining inside the current window after this check. */
  remaining: number
  /** Wall-clock instant the window's oldest hit ages out. */
  resetAt: Date
}

// ---------------------------------------------------------------------------
// In-memory token bucket — secondary floor when Postgres is unreachable.
//
// Conservative: limit/4 requests per window*4. The wider window prevents
// a burst of requests at the start of each interval from draining the
// floor bucket before Postgres recovers.
//
// This map lives in the module scope. Under Vercel each serverless instance
// has its own in-process Map, so the floor is per-instance, not global.
// That is intentional — the floor is a safety net against total
// rate-limit bypass during infra failures, not a precise global counter.
// ---------------------------------------------------------------------------

const inMemoryBuckets = new Map<string, { tokens: number; resetAt: number }>()

function inMemoryCheck(key: string, limit: number, windowSec: number): boolean {
  const floor = Math.max(1, Math.floor(limit / 4))
  const windowMs = windowSec * 4 * 1000
  const now = Date.now()
  const bucket = inMemoryBuckets.get(key)
  if (!bucket || now > bucket.resetAt) {
    inMemoryBuckets.set(key, { tokens: floor - 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.tokens <= 0) return false
  bucket.tokens--
  return true
}

// ---------------------------------------------------------------------------
// Circuit breaker — skips Postgres after 3 consecutive failures.
// Resets automatically after 60 seconds. Emits a metric on open.
// ---------------------------------------------------------------------------

let consecutiveFailures = 0
let circuitOpen = false
let circuitOpenUntil = 0

const CIRCUIT_FAILURE_THRESHOLD = 3
const CIRCUIT_OPEN_MS = 60_000

function recordPgFailure(key: string, reason: string): void {
  consecutiveFailures++
  void recordCounter('rate_limit_infra_error', {
    dimension: { key_prefix: keyPrefix(key), error: reason },
  })
  if (!circuitOpen && consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpen = true
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS
    console.warn(
      `[rate-limit] circuit OPEN after ${CIRCUIT_FAILURE_THRESHOLD} consecutive Postgres failures — using in-memory floor for 60s`,
    )
    void recordCounter('rate_limit_circuit_open', { dimension: { key_prefix: keyPrefix(key) } })
  }
}

function recordPgSuccess(): void {
  if (consecutiveFailures > 0 || circuitOpen) {
    console.info('[rate-limit] Postgres recovered — closing circuit')
  }
  consecutiveFailures = 0
  circuitOpen = false
  circuitOpenUntil = 0
}

function isCircuitOpen(): boolean {
  if (!circuitOpen) return false
  if (Date.now() > circuitOpenUntil) {
    // Auto-reset: allow one probe attempt through
    circuitOpen = false
    circuitOpenUntil = 0
    return false
  }
  return true
}

/**
 * Check + (if allowed) consume one hit against a sliding-window limit.
 *
 * Atomic at the database layer (advisory lock + row update in the RPC) —
 * concurrent callers for the same key serialise. Different keys do not
 * contend.
 *
 * When Postgres is unreachable (or circuit is open), falls back to an
 * in-memory token bucket (limit/4 per window*4) rather than failing open.
 */
export async function checkRateLimit(
  input: RateLimitInput,
): Promise<RateLimitResult> {
  const { key, limit, windowSec } = input

  // Guard: forbid ':shared' namespace — callers must use per-venue keys.
  if (key.includes(':shared')) {
    throw new Error(
      `rate-limit: forbidden key namespace ':shared' — use per-venue keys (got: "${key}")`,
    )
  }

  // If Postgres circuit is open, skip it immediately and use in-memory floor.
  if (isCircuitOpen()) {
    const allowed = inMemoryCheck(key, limit, windowSec)
    void recordCounter(allowed ? 'rate_limit_allow' : 'rate_limit_deny', {
      dimension: { key_prefix: keyPrefix(key), source: 'in_memory_circuit_open' },
    })
    return {
      ok: allowed,
      remaining: allowed ? Math.max(0, Math.floor(limit / 4) - 1) : 0,
      resetAt: new Date(Date.now() + windowSec * 4 * 1000),
    }
  }

  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_sec: windowSec,
    })

    if (error) {
      console.warn(
        '[rate-limit] check_rate_limit RPC error, using in-memory floor:',
        redactError(error),
      )
      recordPgFailure(key, 'rpc_error')
      const allowed = inMemoryCheck(key, limit, windowSec)
      void recordCounter(allowed ? 'rate_limit_allow' : 'rate_limit_deny', {
        dimension: { key_prefix: keyPrefix(key), source: 'in_memory_rpc_error' },
      })
      return {
        ok: allowed,
        remaining: allowed ? Math.max(0, Math.floor(limit / 4) - 1) : 0,
        resetAt: new Date(Date.now() + windowSec * 4 * 1000),
      }
    }

    // RPC returns SETOF (allowed, remaining, reset_at). Supabase JS
    // surfaces a SETOF function as an array of rows.
    const row = Array.isArray(data) ? data[0] : data

    if (!row) {
      console.warn('[rate-limit] check_rate_limit returned no row, using in-memory floor')
      recordPgFailure(key, 'empty_row')
      const allowed = inMemoryCheck(key, limit, windowSec)
      void recordCounter(allowed ? 'rate_limit_allow' : 'rate_limit_deny', {
        dimension: { key_prefix: keyPrefix(key), source: 'in_memory_empty_row' },
      })
      return {
        ok: allowed,
        remaining: allowed ? Math.max(0, Math.floor(limit / 4) - 1) : 0,
        resetAt: new Date(Date.now() + windowSec * 4 * 1000),
      }
    }

    // Postgres succeeded — reset circuit breaker state.
    recordPgSuccess()

    const allowed = Boolean(row.allowed)
    const result: RateLimitResult = {
      ok: allowed,
      remaining: Number(row.remaining ?? 0),
      resetAt: new Date(row.reset_at),
    }

    void recordCounter(
      allowed ? 'rate_limit_allow' : 'rate_limit_deny',
      { dimension: { key_prefix: keyPrefix(key) } },
    )

    return result
  } catch (err) {
    console.warn('[rate-limit] threw, using in-memory floor:', redactError(err))
    recordPgFailure(key, 'thrown')
    const allowed = inMemoryCheck(key, limit, windowSec)
    void recordCounter(allowed ? 'rate_limit_allow' : 'rate_limit_deny', {
      dimension: { key_prefix: keyPrefix(key), source: 'in_memory_thrown' },
    })
    return {
      ok: allowed,
      remaining: allowed ? Math.max(0, Math.floor(limit / 4) - 1) : 0,
      resetAt: new Date(Date.now() + windowSec * 4 * 1000),
    }
  }
}

/**
 * Helper: seconds until a reset timestamp, clamped to >= 1. Use to build
 * the `Retry-After` header on 429 responses.
 */
export function secondsUntil(resetAt: Date): number {
  const diff = Math.ceil((resetAt.getTime() - Date.now()) / 1000)
  return Math.max(1, diff)
}

/**
 * Pull the prefix off a namespaced key (e.g. 'sage:<id>' -> 'sage') so the
 * counter dimension stays low-cardinality. Falls back to the full key when
 * no `:` is present.
 */
function keyPrefix(key: string): string {
  const idx = key.indexOf(':')
  return idx === -1 ? key : key.slice(0, idx)
}
