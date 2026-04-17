import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Persistent rate limiter backed by Supabase (BUG-12).
//
// Replaces in-memory Map-based limiters that reset on every serverless cold
// start. Backed by the `rate_limits` table and the `increment_rate_limit`
// RPC function (see migration 053_rate_limits.sql).
//
// Usage:
//   const rl = await rateLimit('sage:' + userId, { limit: 20, windowSec: 900 })
//   if (!rl.ok) return 429 with Retry-After: secondsUntil(rl.resetAt)
//
// Graceful degradation: if Supabase is unreachable, we log a warning and
// allow the request through. Better to serve than to block on infra failure.
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  ok: boolean
  remaining: number
  resetAt: Date
}

export interface RateLimitOptions {
  limit: number
  windowSec: number
}

export async function rateLimit(
  key: string,
  opts: RateLimitOptions
): Promise<RateLimitResult> {
  const { limit, windowSec } = opts

  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase.rpc('increment_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_sec: windowSec,
    })

    if (error) {
      console.warn('[rate-limit] RPC error, allowing request:', error.message)
      return {
        ok: true,
        remaining: limit,
        resetAt: new Date(Date.now() + windowSec * 1000),
      }
    }

    // RPC returns a table (one row). Supabase JS returns an array.
    const row = Array.isArray(data) ? data[0] : data

    if (!row) {
      console.warn('[rate-limit] RPC returned no row, allowing request')
      return {
        ok: true,
        remaining: limit,
        resetAt: new Date(Date.now() + windowSec * 1000),
      }
    }

    return {
      ok: Boolean(row.allowed),
      remaining: Number(row.remaining ?? 0),
      resetAt: new Date(row.reset_at),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[rate-limit] Threw, allowing request:', message)
    return {
      ok: true,
      remaining: limit,
      resetAt: new Date(Date.now() + windowSec * 1000),
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: seconds until a reset timestamp, clamped to >= 1.
// Useful when building a Retry-After header.
// ---------------------------------------------------------------------------

export function secondsUntil(resetAt: Date): number {
  const diff = Math.ceil((resetAt.getTime() - Date.now()) / 1000)
  return Math.max(1, diff)
}
