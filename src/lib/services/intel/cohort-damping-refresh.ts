/**
 * Bloom House — Cohort damping cache refresh (migration 319).
 *
 * Anchor docs
 * -----------
 *   - migration 319_cohort_damping_cache.sql — the table + view shape.
 *   - migration 316_heat_as_view.sql — the parent wedding_heat view.
 *   - src/lib/services/heat-mapping.ts — getCohortBookingRate +
 *     applyCohortDamping (the original TS-only damping path we are
 *     reconciling with).
 *
 * What this service does
 * ----------------------
 * Once per day (cron job 'cohort_damping_refresh' in src/app/api/cron/
 * route.ts), this walks every active venue, enumerates the discrete
 * cohort signatures present in the venue's recent weddings, and
 * UPSERTs one cache row per (venue, signature) with:
 *
 *   - cohort_size      : count of comparable weddings in last 3y
 *   - cohort_booked    : count of those that converted (booked|completed)
 *   - booking_rate     : cohort_booked / cohort_size
 *   - multiplier       : applyCohortDamping output (0.5 / 0.7 / 1.0)
 *   - cap_tier         : 'warm' when booking_rate < 10%, else null
 *
 * The wedding_heat view LEFT JOINs this cache so the lead-detail badge
 * and the narration agree on the damped score. Missing cache rows
 * (fresh venues, new buckets, post-deploy gap before first cron run)
 * degrade gracefully to multiplier=1.0 (no damping).
 *
 * Drift note
 * ----------
 * The discrete signature bucket here is COARSER than the legacy TS
 * top-K similarity in heat-mapping.ts:174 (which uses z-score continuous
 * similarity per pair of weddings). This is the deliberate reconciliation:
 * a bucket-keyed cache is the only way to make the multiplier consistent
 * across all weddings in the same cohort, which the view needs in order
 * to apply damping symmetrically. The TS getCohortBookingRate function
 * is preserved (still used by the narration fallback) but the cache is
 * the canonical source for damping going forward.
 *
 * Bounds
 * ------
 *   - One pass over all active venues per call. No per-tick row cap —
 *     a venue with N distinct signatures emits N UPSERTs, typical N
 *     is single-digit for early-stage venues, low-double-digit at
 *     scale.
 *   - Never throws. Per-venue + per-signature errors are logged and
 *     counted.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { computeCohortSignature } from '@/lib/services/insights/cohort-signature'

const COHORT_RECENCY_YEARS = 3
const DAY_MS = 86_400_000
const COHORT_MIN_MEMBERS = 5

// Damping thresholds + multipliers. MUST stay aligned with
// applyCohortDamping() in heat-mapping.ts:309 — they are the same
// decision tree, just emitted at refresh time instead of per-read.
const COHORT_DAMPING_THRESHOLD_LOW = 0.10
const COHORT_DAMPING_THRESHOLD_MID = 0.20
const COHORT_DAMPING_LOW_MULTIPLIER = 0.5
const COHORT_DAMPING_MID_MULTIPLIER = 0.7

export interface CohortDampingRefreshResult {
  venues: number
  signatures: number
  errors: number
}

interface VenueRow {
  id: string
}

interface WeddingRow {
  id: string
  status: string | null
  source: string | null
  guest_count_estimate: number | null
  wedding_date: string | null
}

/**
 * Refresh the cohort_damping_cache table. When `options.venueId` is
 * supplied the refresh is scoped to that venue; otherwise iterates
 * every active venue. Always returns a result; per-venue errors are
 * swallowed + counted.
 */
export async function refreshCohortDampingCache(
  supabase: ReturnType<typeof createServiceClient>,
  options?: { venueId?: string },
): Promise<CohortDampingRefreshResult> {
  let venues: VenueRow[] = []
  if (options?.venueId) {
    venues = [{ id: options.venueId }]
  } else {
    const { data, error } = await supabase
      .from('venues')
      .select('id')
      .eq('status', 'active')
    if (error) {
      console.error('[cohort-damping-refresh] active-venue scan failed:', error.message)
      return { venues: 0, signatures: 0, errors: 1 }
    }
    venues = (data ?? []) as VenueRow[]
  }

  let signatures = 0
  let errors = 0

  for (const venue of venues) {
    try {
      const perVenue = await refreshOneVenue(supabase, venue.id)
      signatures += perVenue.signatures
      errors += perVenue.errors
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[cohort-damping-refresh] venue=${venue.id} failed:`, msg)
      errors++
    }
  }

  return { venues: venues.length, signatures, errors }
}

/**
 * Refresh one venue. Reads all candidate weddings, buckets by
 * signature, computes (size, booked, rate, multiplier, cap_tier) per
 * bucket, and UPSERTs one row per bucket. Returns counts.
 */
async function refreshOneVenue(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
): Promise<{ signatures: number; errors: number }> {
  // Candidate weddings: same venue, last 3 years, terminal status. We
  // also need to include status='inquiry' weddings so a fresh inquiry's
  // bucket has a cache row to JOIN against in the view (even when the
  // inquiry itself doesn't contribute to cohort_booked). The inquiry
  // weddings are filtered OUT of the size/booked counts below — they're
  // only there to make sure every active bucket exists in the cache.
  const cutoff = new Date(Date.now() - COHORT_RECENCY_YEARS * 365 * DAY_MS).toISOString()
  const { data, error } = await supabase
    .from('weddings')
    .select('id, status, source, guest_count_estimate, wedding_date')
    .eq('venue_id', venueId)
    .gte('inquiry_date', cutoff)
  if (error) {
    console.error(`[cohort-damping-refresh] venue=${venueId} weddings read failed:`, error.message)
    return { signatures: 0, errors: 1 }
  }

  const rows = (data ?? []) as WeddingRow[]
  if (rows.length === 0) return { signatures: 0, errors: 0 }

  // Bucket by signature. Track size (terminal members only) +
  // booked count per signature.
  const buckets = new Map<string, { size: number; booked: number; hasAnyMember: boolean }>()

  for (const r of rows) {
    const sig = computeCohortSignature({
      source: r.source,
      guest_count_estimate: r.guest_count_estimate,
      wedding_date: r.wedding_date,
    })

    const status = r.status ?? 'inquiry'
    const isTerminal = status === 'booked' || status === 'completed' || status === 'lost'
    const isBooked = status === 'booked' || status === 'completed'

    const entry = buckets.get(sig) ?? { size: 0, booked: 0, hasAnyMember: false }
    entry.hasAnyMember = true
    if (isTerminal) {
      entry.size++
      if (isBooked) entry.booked++
    }
    buckets.set(sig, entry)
  }

  let signatures = 0
  let errors = 0

  for (const [sig, bucket] of buckets) {
    // Only UPSERT buckets that have enough terminal members to be
    // informative. Below the floor we skip — the view's LEFT JOIN will
    // miss + degrade to multiplier=1.0 (no damping) which mirrors the
    // TS applyCohortDamping null-cohort case.
    if (bucket.size < COHORT_MIN_MEMBERS) continue

    const rate = bucket.booked / bucket.size

    // Damping decision — same thresholds as applyCohortDamping().
    let multiplier = 1.0
    let capTier: string | null = null
    if (rate < COHORT_DAMPING_THRESHOLD_LOW) {
      multiplier = COHORT_DAMPING_LOW_MULTIPLIER
      capTier = 'warm'
    } else if (rate < COHORT_DAMPING_THRESHOLD_MID) {
      multiplier = COHORT_DAMPING_MID_MULTIPLIER
    }

    const { error: upErr } = await supabase
      .from('cohort_damping_cache')
      .upsert(
        {
          venue_id: venueId,
          cohort_signature: sig,
          cohort_size: bucket.size,
          cohort_booked: bucket.booked,
          booking_rate: rate,
          multiplier,
          cap_tier: capTier,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'venue_id,cohort_signature' },
      )

    if (upErr) {
      console.error(
        `[cohort-damping-refresh] venue=${venueId} sig=${sig} upsert failed:`,
        upErr.message,
      )
      errors++
    } else {
      signatures++
    }
  }

  return { signatures, errors }
}
