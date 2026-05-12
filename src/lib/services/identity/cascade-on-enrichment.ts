/**
 * Identity-discovery cascade.
 *
 * Triggered the moment a couple becomes "known" on a wedding row — a
 * fresh email lands via body-extract, an SMS body resolves to a
 * person, an operator overrides a name on the Name Evidence panel,
 * a backfill script enriches a placeholder wedding. Before this
 * service existed, those moments fired the writer (people row gets
 * email + first names) but no follow-up scan ever ran until the next
 * 24h backtrack cron. That meant the couple's Instagram, Knot,
 * Pinterest, WeddingWire storefront signals stayed orphaned in
 * candidate_identities + tangential_signals under anonymous handles
 * for up to a day after we knew who they were.
 *
 * The cascade is the missing trigger. It runs three existing services
 * back to back, fire-and-forget:
 *   1. runBacktrackForWedding — scans unresolved storefront
 *      candidate_identities (Knot, IG, Pinterest, WW) for matches
 *      against the wedding's now-known partner names + state +
 *      inquiry window. High-confidence matches auto-link, medium
 *      goes to the coordinator review queue.
 *   2. resolveForWedding — runs the Tier-1 deterministic + Tier-2 AI
 *      adjudicator on every still-unresolved candidate in the venue.
 *      Catches cases where an exact-email match now exists (the
 *      couple texted us their email which we just stamped on the
 *      person row) so a Pinterest "rosaliehoyle" candidate that had
 *      the same email gets linked.
 *   3. recomputeFirstTouch — re-elects the earliest pre-inquiry
 *      attribution_event as is_first_touch=true so the wedding's
 *      forensic origin updates with any newly-discovered earlier
 *      signal.
 *
 * Contract:
 *   - Fire-and-forget — never throws. Errors get logged + counted in
 *     the return shape.
 *   - Idempotent — re-firing on a wedding whose cascade already ran
 *     is a no-op. backtrack stamps backtrack_attempted_at, resolver
 *     skips resolved candidates, recomputeFirstTouch is naturally
 *     convergent.
 *   - Callers NEVER block. The cascade is always a side-effect; if a
 *     caller is on a hot path (SMS persist, live email pipeline)
 *     they should `void triggerIdentityCascade(...)` to drop the
 *     promise.
 *
 * Anchor: bloom-constitution.md Point-Zero doctrine. Pre-zero
 * tangential signals are attribution credit; the cascade is what
 * makes them credit-able the moment an identity binding becomes
 * possible, instead of waiting for the daily sweep.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { runBacktrackForWedding } from './backtrack'
import { resolveForWedding, recomputeFirstTouch } from './candidate-resolver'
import { logEvent } from '@/lib/observability/logger'

export interface CascadeArgs {
  /** Required for log scope. Pass through whatever scope you had —
   *  if the caller has only weddingId, do a venue lookup first. */
  venueId: string
  weddingId: string
  supabase: SupabaseClient
  /** Short label for telemetry — 'enrich_from_body_emails',
   *  'sms_body_email_match', 'name_evidence_override', 'manual_cli'. */
  reason: string
  /** Threaded through logEvent so the cascade joins the parent
   *  inbound event's lineage when available. */
  correlationId?: string | null
}

export interface CascadeResult {
  backtrackHits: number
  /** Highest-confidence matches the backtrack auto-linked. */
  backtrackAutoLinked: number
  /** Medium-confidence backtrack matches queued for coordinator review. */
  backtrackQueued: number
  candidatesResolved: number
  /** Tier-2-AI deferrals that went to coordinator review. */
  candidatesDeferred: number
  firstTouchUpdated: boolean
  errors: string[]
  latencyMs: number
}

function emptyResult(): CascadeResult {
  return {
    backtrackHits: 0,
    backtrackAutoLinked: 0,
    backtrackQueued: 0,
    candidatesResolved: 0,
    candidatesDeferred: 0,
    firstTouchUpdated: false,
    errors: [],
    latencyMs: 0,
  }
}

/**
 * Fire the identity-discovery cascade for one wedding. Always
 * resolves, never rejects. Errors land in `result.errors` and the
 * structured log.
 */
export async function triggerIdentityCascade(
  args: CascadeArgs,
): Promise<CascadeResult> {
  const { venueId, weddingId, supabase, reason, correlationId } = args
  const result = emptyResult()
  const started = Date.now()

  // Stage 1 — backtrack against this specific wedding. Scans every
  // unresolved storefront candidate (Knot, IG, Pinterest, WW, etc.)
  // for fingerprint match against the wedding's now-known partner
  // names + state within the engagement window.
  try {
    const summary = await runBacktrackForWedding(supabase, weddingId)
    result.backtrackAutoLinked = summary.highAutoLinked
    result.backtrackQueued = summary.mediumQueued
    result.backtrackHits = summary.highAutoLinked + summary.mediumQueued
    if (summary.errors.length > 0) {
      result.errors.push(...summary.errors.map((e) => `backtrack: ${e}`))
    }
  } catch (err) {
    result.errors.push(
      `backtrack threw: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Stage 2 — resolve every unresolved candidate in the venue. The
  // resolver re-checks Tier-1 exact-email / exact-phone / exact-handle
  // paths, which is where the just-enriched email or handle gets to
  // pick up its anonymous shadow. skipAI=false at trigger time is
  // intentional: enrichment is a real "new identity binding" event
  // worth spending a Claude call on; the cron uses skipAI=true to
  // avoid retrying ambiguous cases nightly.
  try {
    const resolved = await resolveForWedding({ supabase, weddingId })
    result.candidatesResolved =
      resolved.resolved_tier_1_exact +
      resolved.resolved_tier_1_name_window +
      resolved.resolved_tier_1_full_name +
      resolved.resolved_tier_2_ai +
      resolved.resolved_tier_2_wide_ai
    result.candidatesDeferred = resolved.deferred_to_ai
    if (resolved.errors.length > 0) {
      result.errors.push(...resolved.errors.map((e) => `resolver: ${e}`))
    }
  } catch (err) {
    result.errors.push(
      `resolver threw: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Stage 3 — recompute first-touch. Cheap, deterministic, runs even
  // when stages 1 + 2 found nothing (callers may have stamped an
  // attribution row directly via the override path). The backtrack
  // auto-link path already calls recomputeFirstTouch internally per
  // successful link, but firing it once here covers the cases where
  // no new attribution landed but a manual coordinator action still
  // needs the flag recomputed.
  try {
    const ft = await recomputeFirstTouch(supabase, weddingId)
    if (ft.error) {
      result.errors.push(`first_touch: ${ft.error}`)
    } else {
      result.firstTouchUpdated = true
    }
  } catch (err) {
    result.errors.push(
      `first_touch threw: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  result.latencyMs = Date.now() - started

  // Structured log so the audit trail captures every cascade fire +
  // its outcome. event_type is the stable string ops will filter on.
  logEvent({
    level: result.errors.length > 0 ? 'warn' : 'info',
    msg: 'identity.cascade',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'identity.cascade',
    outcome: result.errors.length > 0 ? 'fail' : 'ok',
    latency_ms: result.latencyMs,
    data: {
      wedding_id: weddingId,
      reason,
      backtrack_auto_linked: result.backtrackAutoLinked,
      backtrack_queued: result.backtrackQueued,
      candidates_resolved: result.candidatesResolved,
      candidates_deferred: result.candidatesDeferred,
      first_touch_updated: result.firstTouchUpdated,
      error_count: result.errors.length,
      first_error: result.errors[0] ?? null,
    },
  })

  return result
}

// ---------------------------------------------------------------------------
// Venue-wide + all-venues sweeps
// ---------------------------------------------------------------------------
//
// The per-wedding trigger above fires when a SPECIFIC wedding gets new
// identity signals. The reverse case is equally important: a new
// ANONYMOUS signal arrives (operator confirms a Knot CSV upload, an
// Instagram screenshot, a Pinterest scrape) and we need to re-evaluate
// every wedding against it.
//
// Knot + Instagram don't expose APIs — both ingest via operator-driven
// brain-dump CSV / screenshot uploads. So the trigger model is:
//   - When operator confirms a brain-dump that produces new candidate
//     signals → fire venue-wide cascade
//   - Plus a daily safety-net cron over every venue
//
// The sweep is bounded to weddings with activity in the last 365 days
// to keep per-tick cost predictable. Closed-and-completed weddings
// older than that don't get re-evaluated (their attribution is settled).

interface VenueCascadeResult {
  venueId: string
  weddingsScanned: number
  totalAutoLinked: number
  totalQueued: number
  totalResolved: number
  totalDeferred: number
  totalErrors: number
}

interface AllVenuesCascadeResult {
  venuesProcessed: number
  totalWeddingsScanned: number
  totalAutoLinked: number
  totalQueued: number
  totalResolved: number
  totalDeferred: number
  totalErrors: number
  perVenue: VenueCascadeResult[]
}

/**
 * Run the cascade for every active wedding on a venue. Used by the
 * daily cron and as the synchronous follow-up to a brain-dump confirm
 * that brings in new anonymous candidate signals.
 *
 * Idempotent — the underlying backtrack / resolver / first-touch
 * services all check their own watermarks + already-resolved state.
 */
export async function runIdentityCascadeForVenue(
  venueId: string,
  supabase: SupabaseClient,
  reason: string,
): Promise<VenueCascadeResult> {
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString()
  const result: VenueCascadeResult = {
    venueId,
    weddingsScanned: 0,
    totalAutoLinked: 0,
    totalQueued: 0,
    totalResolved: 0,
    totalDeferred: 0,
    totalErrors: 0,
  }

  const { data: weddings, error } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .not('status', 'in', '(lost,cancelled,completed)')
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(1000)

  if (error) {
    console.warn(`[cascade-sweep] venue ${venueId} query failed:`, error.message)
    return result
  }

  for (const w of (weddings ?? []) as Array<{ id: string }>) {
    result.weddingsScanned++
    const r = await triggerIdentityCascade({
      venueId,
      weddingId: w.id,
      supabase,
      reason,
    })
    result.totalAutoLinked += r.backtrackAutoLinked
    result.totalQueued += r.backtrackQueued
    result.totalResolved += r.candidatesResolved
    result.totalDeferred += r.candidatesDeferred
    result.totalErrors += r.errors.length
  }

  return result
}

/**
 * Cron entry — iterate every venue, fire the cascade sweep. Returns
 * per-venue + grand totals so the cron route surfaces a useful summary.
 *
 * Cron cadence: daily is plenty. Brain-dump confirms trigger
 * runIdentityCascadeForVenue synchronously, so most newly-uploaded
 * Knot/IG/Pinterest data binds within seconds — the cron is the
 * safety net for the missed-fire cases (cron of a CSV upload that
 * pre-dated the cascade wiring, operator confirmed something offline,
 * etc).
 */
export async function runIdentityCascadeAllVenues(
  supabase: SupabaseClient,
): Promise<AllVenuesCascadeResult> {
  const out: AllVenuesCascadeResult = {
    venuesProcessed: 0,
    totalWeddingsScanned: 0,
    totalAutoLinked: 0,
    totalQueued: 0,
    totalResolved: 0,
    totalDeferred: 0,
    totalErrors: 0,
    perVenue: [],
  }

  // Only iterate non-demo venues with at least one wedding row that
  // updated in the lookback window. Filtering on weddings.updated_at
  // rather than venue activity keeps demo / empty / dormant venues
  // out of the per-tick cost.
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString()
  const { data: venueRows } = await supabase
    .from('weddings')
    .select('venue_id')
    .gte('updated_at', since)
    .limit(5000)

  const venueIds = Array.from(
    new Set(((venueRows ?? []) as Array<{ venue_id: string }>).map((v) => v.venue_id)),
  )

  for (const venueId of venueIds) {
    const r = await runIdentityCascadeForVenue(venueId, supabase, 'cron_daily_sweep')
    out.venuesProcessed++
    out.totalWeddingsScanned += r.weddingsScanned
    out.totalAutoLinked += r.totalAutoLinked
    out.totalQueued += r.totalQueued
    out.totalResolved += r.totalResolved
    out.totalDeferred += r.totalDeferred
    out.totalErrors += r.totalErrors
    out.perVenue.push(r)
  }

  return out
}
