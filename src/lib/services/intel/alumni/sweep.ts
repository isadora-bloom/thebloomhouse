/**
 * Bloom House — Wave 14 alumni-cohort sweep.
 *
 * Anchor docs:
 *   - bloom-constitution.md (aggregate ≠ disclose)
 *   - bloom-data-integrity-sweep.md (the aggregate-only contract)
 *
 * Why this is a service (not embedded in a route)
 * -----------------------------------------------
 * Same pattern as Wave 5A/5B sweeps. /api/cron?job=alumni_cohort_sweep
 * (TODO comment below — cron registration deferred per Wave 14 boundary;
 * reconciliation will add it).
 *
 * Behaviour
 * ---------
 *   1. Pulls up to 3 venues per tick whose newest alumni_cohorts row
 *      is older than 7 days OR who have booked weddings but no
 *      archetype rows yet.
 *   2. For each venue: generateAlumniCohorts → if any rows were
 *      upserted, count it. Failures isolated.
 *   3. Time-boxed at 280s (Vercel Pro 300s ceiling minus 20s buffer).
 *
 * TODO: register cron entry in vercel.json + src/app/api/cron/route.ts
 * after Wave 11/14 land. Job string `alumni_cohort_sweep`. Recommended
 * cadence: weekly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { generateAlumniCohorts } from './generate'

const MAX_VENUES_PER_TICK = 3
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface VenueCandidate {
  venue_id: string
  reason: 'stale' | 'missing'
}

export interface AlumniSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  total_cost_cents: number
  total_archetypes: number
  total_booked_couples: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ venueId: string; error: string }>
}

export interface RunAlumniSweepOptions {
  supabase?: SupabaseClient
  maxVenues?: number
  timeboxMs?: number
}

async function findDriftVenues(
  supabase: SupabaseClient,
  maxVenues: number,
): Promise<VenueCandidate[]> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_MS).toISOString()

  // Pull venues that have any booked weddings (otherwise nothing to
  // generate). Cap at maxVenues * 5 to keep the dedupe filter happy.
  const { data: venueRows } = await supabase
    .from('weddings')
    .select('venue_id')
    .not('booked_at', 'is', null)
    .is('merged_into_id', null)
    .limit(maxVenues * 50)

  const venueSet = new Set<string>()
  for (const r of (venueRows ?? []) as Array<{ venue_id: string }>) {
    venueSet.add(r.venue_id)
  }
  if (venueSet.size === 0) return []

  const candidates: VenueCandidate[] = []
  for (const venueId of Array.from(venueSet)) {
    const { data: existing } = await supabase
      .from('alumni_cohorts')
      .select('refreshed_at')
      .eq('venue_id', venueId)
      .order('refreshed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const refreshedAt = (existing as { refreshed_at?: string } | null)?.refreshed_at ?? null
    if (refreshedAt === null) {
      candidates.push({ venue_id: venueId, reason: 'missing' })
    } else if (refreshedAt < cutoff) {
      candidates.push({ venue_id: venueId, reason: 'stale' })
    }
    if (candidates.length >= maxVenues * 3) break
  }
  return candidates
}

export async function runAlumniSweep(
  options: RunAlumniSweepOptions = {},
): Promise<AlumniSweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const maxVenues = options.maxVenues ?? MAX_VENUES_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  try {
    const candidates = await findDriftVenues(supabase, maxVenues)

    let processed = 0
    let done = 0
    let failed = 0
    let totalCostCents = 0
    let totalArchetypes = 0
    let totalBookedCouples = 0
    let timeboxed = false
    const failures: Array<{ venueId: string; error: string }> = []

    for (const c of candidates) {
      if (processed >= maxVenues) break
      if (Date.now() - startedAt >= timeboxMs) {
        timeboxed = true
        break
      }
      processed += 1
      try {
        const result = await generateAlumniCohorts({ venueId: c.venue_id }, { supabase })
        totalCostCents += result.costCents
        totalArchetypes += result.archetypesUpserted
        totalBookedCouples += result.bookedCoupleCount
        done += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed += 1
        failures.push({ venueId: c.venue_id, error: message })
      }
    }

    return {
      ok: true,
      processed,
      done,
      failed,
      total_cost_cents: Math.round(totalCostCents * 10_000) / 10_000,
      total_archetypes: totalArchetypes,
      total_booked_couples: totalBookedCouples,
      timeboxed,
      duration_ms: Date.now() - startedAt,
      failures: failures.slice(0, 20),
    }
  } catch (err) {
    return {
      ok: false,
      processed: 0,
      done: 0,
      failed: 0,
      total_cost_cents: 0,
      total_archetypes: 0,
      total_booked_couples: 0,
      timeboxed: false,
      duration_ms: Date.now() - startedAt,
      failures: [
        { venueId: '__sweep__', error: err instanceof Error ? err.message : String(err) },
      ],
    }
  }
}
