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
 * Failure mode: the durable layer's only failure path is "Postgres is
 * unreachable / the RPC threw." Per the task contract we fail OPEN — allow
 * the request through, log via redactError, bump the
 * `rate_limit_infra_error` counter so the dashboard surfaces it. We do NOT
 * fall back to an in-memory map (that would silently degrade to broken
 * behaviour). If the durable layer is consistently down, we'd rather take
 * the abuse risk than the false-rate-limit risk.
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

/**
 * Check + (if allowed) consume one hit against a sliding-window limit.
 *
 * Atomic at the database layer (FOR UPDATE on the key row) — concurrent
 * callers for the same key serialise. Different keys do not contend.
 */
export async function checkRateLimit(
  input: RateLimitInput,
): Promise<RateLimitResult> {
  const { key, limit, windowSec } = input
  const fallbackResult: RateLimitResult = {
    // Fail OPEN on infrastructure error — see header comment.
    ok: true,
    remaining: limit,
    resetAt: new Date(Date.now() + windowSec * 1000),
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
        '[rate-limit] check_rate_limit RPC error, failing open:',
        redactError(error),
      )
      void recordCounter('rate_limit_infra_error', {
        dimension: { key_prefix: keyPrefix(key), error: 'rpc_error' },
      })
      return fallbackResult
    }

    // RPC returns SETOF (allowed, remaining, reset_at). Supabase JS
    // surfaces a SETOF function as an array of rows.
    const row = Array.isArray(data) ? data[0] : data

    if (!row) {
      console.warn('[rate-limit] check_rate_limit returned no row, failing open')
      void recordCounter('rate_limit_infra_error', {
        dimension: { key_prefix: keyPrefix(key), error: 'empty_row' },
      })
      return fallbackResult
    }

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
    console.warn('[rate-limit] threw, failing open:', redactError(err))
    void recordCounter('rate_limit_infra_error', {
      dimension: { key_prefix: keyPrefix(key), error: 'thrown' },
    })
    return fallbackResult
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
 * Pull the prefix off a namespaced key (e.g. 'sage:<id>' → 'sage') so the
 * counter dimension stays low-cardinality. Falls back to the full key when
 * no `:` is present.
 */
function keyPrefix(key: string): string {
  const idx = key.indexOf(':')
  return idx === -1 ? key : key.slice(0, idx)
}
