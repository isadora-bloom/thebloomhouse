/**
 * Metered counters + histograms (OPS-21.2.3 / Playbook 21.2).
 *
 * Generic write helpers for the metered_events + cron_runs tables
 * (migration 151). Fire-and-forget — observability writes must NEVER
 * fail the caller's request. Errors swallowed with console.warn.
 *
 * Three primitives:
 *   recordCounter(name, opts) — bump a counter by 1 (default value)
 *   recordHistogram(name, value, opts) — record a numeric observation
 *   trackCronRun(name, fn, opts) — wrap a cron handler in a cron_runs
 *     row that captures started_at / ended_at / duration_ms / status /
 *     error_message + auto-rolls failures.
 *
 * Aggregation lives in src/lib/observability/metrics-aggregate.ts
 * (read path; this file is write-only).
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface CounterOpts {
  /** Optional venue scope. NULL = global. */
  venueId?: string | null
  /** Counter-specific dimensions (stage / outcome / channel / etc.). */
  dimension?: Record<string, unknown>
}

export interface HistogramOpts extends CounterOpts {
  /** ISO timestamp override (default now). Useful for backfill. */
  observedAt?: string
}

/**
 * Bump a counter by 1 (or by a custom value via the optional `value`
 * arg). Fire-and-forget: never throws.
 */
export async function recordCounter(
  name: string,
  opts: CounterOpts & { value?: number } = {},
): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase.from('metered_events').insert({
      counter_name: name,
      venue_id: opts.venueId ?? null,
      value: opts.value ?? 1,
      dimension: opts.dimension ?? {},
    })
  } catch (err) {
    console.warn(`[metrics] recordCounter('${name}') failed:`, err instanceof Error ? err.message : err)
  }
}

/**
 * Record a numeric observation for histogram aggregation
 * (latency_ms, row_count, etc.). Fire-and-forget.
 */
export async function recordHistogram(
  name: string,
  value: number,
  opts: HistogramOpts = {},
): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase.from('metered_events').insert({
      counter_name: name,
      venue_id: opts.venueId ?? null,
      value,
      dimension: opts.dimension ?? {},
      observed_at: opts.observedAt ?? new Date().toISOString(),
    })
  } catch (err) {
    console.warn(`[metrics] recordHistogram('${name}') failed:`, err instanceof Error ? err.message : err)
  }
}

export interface CronRunOpts {
  /** Optional venue scope. NULL = global cron (e.g., FRED daily fetch). */
  venueId?: string | null
  /** Free-form structured payload (per-step counts, etc.). */
  metadata?: Record<string, unknown>
}

export interface CronRunResult<T> {
  /** Inserted cron_runs.id; null when the insert itself failed. */
  cronRunId: string | null
  /** What the wrapped fn returned. */
  result?: T
  /** True when the wrapped fn threw. */
  failed: boolean
  /** Wall-clock ms for the wrapped fn. */
  duration_ms: number
}

/**
 * Wrap a cron handler in a cron_runs row. Inserts a 'running' row up
 * front; on completion writes ended_at + status + duration_ms. On
 * exception: stamps status='failure' + error_message + error_class.
 *
 * Returns the original function's result + the cron_run id so callers
 * can stamp metadata after the fact.
 */
export async function trackCronRun<T>(
  cronName: string,
  fn: (cronRunId: string | null) => Promise<T>,
  opts: CronRunOpts = {},
): Promise<CronRunResult<T>> {
  const startedAt = new Date()
  const startMs = startedAt.getTime()
  let cronRunId: string | null = null
  const supabase = createServiceClient()
  try {
    const { data } = await supabase
      .from('cron_runs')
      .insert({
        cron_name: cronName,
        venue_id: opts.venueId ?? null,
        started_at: startedAt.toISOString(),
        status: 'running',
        metadata: opts.metadata ?? {},
      })
      .select('id')
      .single()
    cronRunId = (data?.id as string | undefined) ?? null
  } catch (err) {
    console.warn(`[metrics] trackCronRun('${cronName}') insert failed:`, err instanceof Error ? err.message : err)
  }

  try {
    const result = await fn(cronRunId)
    const endMs = Date.now()
    const duration_ms = endMs - startMs
    if (cronRunId) {
      try {
        await supabase
          .from('cron_runs')
          .update({
            ended_at: new Date(endMs).toISOString(),
            status: 'success',
            duration_ms,
          })
          .eq('id', cronRunId)
      } catch (err) {
        console.warn(`[metrics] trackCronRun('${cronName}') success-update failed:`, err instanceof Error ? err.message : err)
      }
    }
    return { cronRunId, result, failed: false, duration_ms }
  } catch (err) {
    const endMs = Date.now()
    const duration_ms = endMs - startMs
    if (cronRunId) {
      try {
        await supabase
          .from('cron_runs')
          .update({
            ended_at: new Date(endMs).toISOString(),
            status: 'failure',
            duration_ms,
            error_message: err instanceof Error ? err.message : String(err),
            error_class: classifyError(err),
          })
          .eq('id', cronRunId)
      } catch (innerErr) {
        console.warn(`[metrics] trackCronRun('${cronName}') failure-update failed:`, innerErr instanceof Error ? innerErr.message : innerErr)
      }
    }
    // Re-throw so the caller's error handling still runs.
    throw err
  }
}

/** Classify an error into a coarse bucket for cron_runs.error_class. */
export function classifyError(err: unknown): string {
  if (!err) return 'unknown'
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout'
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('throttl')) return 'rate_limit'
  if (msg.includes('unauthorized') || msg.includes('401') || msg.includes('forbidden') || msg.includes('403')) return 'auth'
  if (msg.includes('not found') || msg.includes('404')) return 'not_found'
  if (msg.includes('econnrefused') || msg.includes('network')) return 'network'
  return 'unknown'
}

// Pure helpers exported for unit tests.
export const __test__ = {
  classifyError,
}
