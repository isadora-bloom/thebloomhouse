/**
 * Pricing-change cascade.
 *
 * Fires after a pricing_history row lands. Every pending draft created
 * BEFORE the effective_date is flagged stale so the coordinator UI can
 * prompt regenerate-with-new-pricing. The drafts column populated:
 * drafts.pricing_stale_at (migration 307).
 *
 * Contract: fire-and-forget. Never throws.
 *
 * Why drafts and not quotes
 * -------------------------
 * The venue's "quote" lives inside the draft body (Sage rendered pricing
 * into the email when generating the reply). When pricing changes the
 * draft body still carries the old number. Coordinator regenerate is
 * the safest path — invalidates the body, re-renders with new pricing.
 *
 * Scope
 * -----
 * Inquiry drafts only (context_type='inquiry'). Booked-client drafts
 * are post-contract and pricing changes don't retroactively affect
 * signed contracts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface PricingCascadeArgs {
  venueId: string
  /** Effective date of the new pricing row (ISO date or datetime). */
  effectiveDate: string
  supabase: SupabaseClient
  correlationId?: string | null
}

export interface PricingCascadeResult {
  draftsFlagged: number
  errors: string[]
  latencyMs: number
}

export async function triggerPricingCascade(
  args: PricingCascadeArgs,
): Promise<PricingCascadeResult> {
  const { venueId, effectiveDate, supabase, correlationId } = args
  const started = Date.now()
  const result: PricingCascadeResult = {
    draftsFlagged: 0,
    errors: [],
    latencyMs: 0,
  }

  try {
    // Effective date arrives as YYYY-MM-DD. Compare to draft created_at
    // (timestamptz). Stamp the staleness flag now() so the UI can show
    // "stale since X" relative to when the operator changed pricing.
    const { data, error } = await supabase
      .from('drafts')
      .update({ pricing_stale_at: new Date().toISOString() })
      .eq('venue_id', venueId)
      .eq('status', 'pending')
      .eq('context_type', 'inquiry')
      .lt('created_at', effectiveDate)
      .is('pricing_stale_at', null)
      .select('id')

    if (error) {
      result.errors.push(`update_failed: ${error.message}`)
    } else {
      result.draftsFlagged = (data ?? []).length
    }
  } catch (err) {
    result.errors.push(
      `threw: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  result.latencyMs = Date.now() - started

  logEvent({
    level: result.errors.length > 0 ? 'warn' : 'info',
    msg: 'cascade.pricing',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'cascade.pricing',
    outcome: result.errors.length > 0 ? 'fail' : 'ok',
    latency_ms: result.latencyMs,
    data: {
      effective_date: effectiveDate,
      drafts_flagged: result.draftsFlagged,
      error_count: result.errors.length,
      first_error: result.errors[0] ?? null,
    },
  })

  return result
}
