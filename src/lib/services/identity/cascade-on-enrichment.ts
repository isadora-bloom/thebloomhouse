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
