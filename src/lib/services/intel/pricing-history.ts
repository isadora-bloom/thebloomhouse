/**
 * Pricing-history service helper (T2-B Phase 2 / LIMB-16.2.3).
 *
 * The migration 134 trigger auto-logs base_price + capacity changes.
 * Service-side writers call recordPricingChange for richer fields
 * the trigger doesn't watch — calculator config edits, tier
 * restructuring, weekday discount tweaks, etc.
 *
 * Coordinators see the per-row notes column from
 * /portal/property-state-config (future) or via the read view; the
 * field_name + jsonb old/new shape leaves room for any kind of
 * pricing edit without schema churn.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface RecordPricingChangeArgs {
  venueId: string
  fieldName: string
  oldValue: unknown
  newValue: unknown
  /** Authenticated user_profile id, when known. NULL otherwise. */
  changedBy?: string | null
  /** Origin context — 'admin_ui', 'calculator_import', 'cron',
   *  'pricing_review_2026-04', etc. */
  context?: string | null
  /** Coordinator note explaining the why. INS-19.5.2 elasticity
   *  insight reads this to weight whether the change was demand-side
   *  or supply-side. */
  notes?: string | null
}

/**
 * Append a pricing-history row. Idempotency is the caller's
 * responsibility — append-only by design (the row IS the audit
 * trail).
 */
export async function recordPricingChange(args: RecordPricingChangeArgs): Promise<{ ok: true } | { ok: false; error: string }> {
  const { venueId, fieldName, oldValue, newValue, changedBy, context, notes } = args
  if (!fieldName || !fieldName.trim()) {
    return { ok: false, error: 'fieldName is required' }
  }
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('pricing_history').insert({
      venue_id: venueId,
      field_name: fieldName.trim(),
      old_value: oldValue !== undefined ? oldValue : null,
      new_value: newValue !== undefined ? newValue : null,
      changed_by: changedBy ?? null,
      context: context ?? null,
      notes: notes ?? null,
    })
    if (error) {
      console.error('[pricing-history] insert failed:', error.message)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('[pricing-history] insert exception:', msg)
    return { ok: false, error: msg }
  }
}
