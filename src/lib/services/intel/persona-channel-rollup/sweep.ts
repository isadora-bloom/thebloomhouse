/**
 * Wave 6B — persona × channel rollup sweep service.
 *
 * Anchor docs:
 *   - bloom-wave4-5-6-master-plan.md (6B: weekly recompute across venues
 *     with at least one marketing_spend_records row in the last 90 days)
 *   - feedback_parallel_stream_safety.md (cron registration deferred to
 *     reconciliation stream — see TODO below)
 *
 * What this service does
 * ----------------------
 * Iterate venues that have at least one marketing_spend_records row in
 * the trailing 90 days and recompute their persona × channel rollup.
 * Time-boxed at 5 venues per tick so the cron stays under the 300s
 * Vercel ceiling even when each venue has thousands of attribution
 * events.
 *
 * Cron registration: NOT in this file. Cron registration must land in
 * src/app/api/cron/route.ts (job string 'persona_channel_rollup_sweep')
 * and vercel.json — both files are owned by the reconciliation stream
 * during Wave 6B's parallel run with Wave 5C. See
 * feedback_parallel_stream_safety.md for why we don't touch them from
 * inside a parallel agent.
 *
 * TODO Wave 6B reconciliation: register the cron.
 *   1. Add 'persona_channel_rollup_sweep' to VALID_JOBS in
 *      src/app/api/cron/route.ts
 *   2. Add a case 'persona_channel_rollup_sweep':
 *        return runPersonaChannelRollupSweep()
 *   3. Add a vercel.json cron entry — weekly suggested
 *      (Sunday 7:00am UTC, well clear of daily spend-sync sweeps).
 *   4. Add to DESTRUCTIVE_JOBS in src/lib/cron-auth.ts (the rollup
 *      table is service-role write only; sweep needs the same auth
 *      shape as cohort_rollup_sweep).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'
import { computePersonaChannelRollups } from './compute'

const MAX_VENUES_PER_TICK = 5
const TIMEBOX_MS = 280_000
const SPEND_LOOKBACK_DAYS = 90

export interface PersonaChannelRollupSweepResult {
  ok: boolean
  venuesScanned: number
  venuesComputed: number
  cellsWritten: number
  errors: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ venueId: string; error: string }>
}

export interface RunPersonaChannelRollupSweepOptions {
  supabase?: SupabaseClient
  maxVenues?: number
  timeboxMs?: number
}

/**
 * Walks venues that have at least one spend row in the trailing 90 days
 * and recomputes their rollup. Failure isolation: a single venue throw
 * never aborts the sweep.
 */
export async function runPersonaChannelRollupSweep(
  options: RunPersonaChannelRollupSweepOptions = {},
): Promise<PersonaChannelRollupSweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const maxVenues = options.maxVenues ?? MAX_VENUES_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  const result: PersonaChannelRollupSweepResult = {
    ok: true,
    venuesScanned: 0,
    venuesComputed: 0,
    cellsWritten: 0,
    errors: 0,
    timeboxed: false,
    duration_ms: 0,
    failures: [],
  }

  try {
    // Pull venue ids with at least one spend row in the trailing 90d.
    // Over-fetch and dedupe in JS — PostgREST DISTINCT isn't first-class.
    const cutoffMs = Date.now() - SPEND_LOOKBACK_DAYS * 86_400_000
    const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10)

    const { data, error } = await supabase
      .from('marketing_spend_records')
      .select('venue_id, spend_date')
      .gte('spend_date', cutoffDate)
      .order('spend_date', { ascending: false })
      .limit(2000)

    if (error) {
      logEvent({
        level: 'warn',
        msg: 'persona_channel_rollup_sweep.lookup_failed',
        event_type: 'cron.run',
        outcome: 'fail',
        data: { error: error.message },
      })
      result.errors += 1
      result.ok = false
      result.duration_ms = Date.now() - startedAt
      return result
    }

    const seen = new Set<string>()
    const venueIds: string[] = []
    for (const row of (data ?? []) as Array<{ venue_id: string }>) {
      if (!row.venue_id || seen.has(row.venue_id)) continue
      seen.add(row.venue_id)
      venueIds.push(row.venue_id)
      if (venueIds.length >= maxVenues) break
    }

    result.venuesScanned = venueIds.length

    for (const venueId of venueIds) {
      if (Date.now() - startedAt >= timeboxMs) {
        result.timeboxed = true
        break
      }
      try {
        const r = await computePersonaChannelRollups({ venueId, supabase })
        result.venuesComputed += 1
        result.cellsWritten += r.cellsWritten
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors += 1
        result.failures.push({ venueId, error: message })
        logEvent({
          level: 'warn',
          msg: 'persona_channel_rollup_sweep.venue_threw',
          event_type: 'cron.run',
          outcome: 'fail',
          venueId,
          data: { error: message },
        })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    result.errors += 1
    result.ok = false
    result.failures.push({ venueId: '__sweep__', error: message })
  }

  result.duration_ms = Date.now() - startedAt

  logEvent({
    level: 'info',
    msg: 'persona_channel_rollup_sweep.complete',
    event_type: 'cron.run',
    outcome: result.errors > 0 ? 'fail' : 'ok',
    data: {
      venuesScanned: result.venuesScanned,
      venuesComputed: result.venuesComputed,
      cellsWritten: result.cellsWritten,
      errors: result.errors,
      timeboxed: result.timeboxed,
      duration_ms: result.duration_ms,
    },
  })

  return result
}
