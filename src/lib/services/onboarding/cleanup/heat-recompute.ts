/**
 * Step 6 of the onboarding cleanup pipeline — recompute heat scores.
 *
 * Extracted from scripts/recompute-heat-after-reclassify.ts (kept as a
 * thin CLI wrapper). Runs last — after direction reclassification
 * deletes false-positive engagement events, heat may be inflated
 * (each false positive can add up to +15). recalculateHeatScore
 * itself is inherently mutating (it writes the recomputed score back
 * as a side effect of computing it), so dry-run reports this step as
 * skipped rather than pretending to preview counts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { recalculateHeatScore } from '@/lib/services/heat-mapping'
import type { CleanupStepResult } from './types'
import { emptyResult } from './types'

export async function recomputeHeatAfterCleanup(
  sb: SupabaseClient,
  venueId: string,
  apply: boolean,
): Promise<CleanupStepResult> {
  const result = emptyResult('heat_recompute', '6. Recompute heat scores')

  if (!apply) {
    result.skipped = true
    result.skipReason = 'recalculateHeatScore writes as it computes — no dry-run preview available. Counts appear once Apply runs.'
    return result
  }

  // Heat is not a column on weddings; it lives on wedding_heat (one row per
  // wedding). Read the current scores there so "changed" is measured
  // against what the venue actually sees.
  const { data: weddings, error } = await sb
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
  if (error) {
    result.ok = false
    result.errors.push(error.message)
    return result
  }
  const { data: heatRows } = await sb
    .from('wedding_heat')
    .select('wedding_id, heat_score')
    .eq('venue_id', venueId)
  const currentHeat = new Map<string, number | null>()
  for (const h of (heatRows ?? []) as Array<{ wedding_id: string; heat_score: number | null }>) {
    currentHeat.set(h.wedding_id, h.heat_score)
  }

  let total = 0
  let updated = 0
  const errors: string[] = []
  for (const w of (weddings ?? []) as Array<{ id: string }>) {
    total++
    try {
      const res = await recalculateHeatScore(venueId, w.id)
      if (res.newScore !== (currentHeat.get(w.id) ?? null)) updated++
    } catch (err) {
      errors.push(`${w.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.counts = { weddings_recomputed: total, scores_changed: updated }
  result.errors = errors
  return result
}
