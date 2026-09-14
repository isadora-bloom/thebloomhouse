/**
 * Attribution conflict resolution — the legacy-ledger repair actions.
 *
 * What this is, honestly
 * ---------------------
 * `attribution_events` is the pre-spine attribution ledger. The couple
 * spine does not have it and will not grow it: channel credit is derived
 * from the couple's touchpoint ribbon now
 * (`buildCoupleAttribution` → `getSourceAttribution`), not from a row an
 * importer decided was the first touch. So there is nothing on the spine
 * to migrate these three actions onto, and nothing on the spine they
 * should be reimplemented against.
 *
 * What they are is repair: a coordinator settling a conflict between a
 * computed first touch and the raw self-reported `weddings.source` that
 * the importer wrote. The queue exists because those two disagree, and
 * it empties as the reimport lands. That is a legacy-ledger job, and it
 * belongs beside the other legacy-ledger code in `src/lib/services`,
 * not behind a coordinator surface — which is why W64 moved it here
 * rather than leaving three table names in a route handler and calling
 * that a canonical read.
 *
 * Nothing here is reachable from a page. The API route above it does
 * auth, tenancy and nothing else.
 *
 * Doctrine reference: bloom-repair-endpoint-classification — repair
 * endpoints are legacy-only by design.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { recomputeFirstTouch } from '@/lib/services/identity/candidate-resolver'
import { recalculateHeatScore } from '@/lib/services/heat-mapping'
import { normalizeSource } from '@/lib/services/normalize-source'

export type ConflictAction = 'revert' | 'accept_legacy' | 'accept_computed'

export interface AttributionEventRow {
  id: string
  venue_id: string
  wedding_id: string
  source_platform: string
  conflict_with_legacy_source: string | null
  reverted_at: string | null
}

export type ResolutionResult =
  | { ok: true; newSource?: string }
  | { ok: false; status: number; error: string }

/** Fetch the ledger row the coordinator clicked. Returns null when it is
 *  gone, so the caller can 404 rather than act on nothing. */
export async function loadAttributionEvent(
  supabase: SupabaseClient,
  eventId: string,
): Promise<AttributionEventRow | null> {
  const { data, error } = await supabase
    .from('attribution_events')
    .select('id, venue_id, wedding_id, source_platform, conflict_with_legacy_source, reverted_at')
    .eq('id', eventId)
    .maybeSingle()
  if (error || !data) return null
  return data as AttributionEventRow
}

/** The venue that owns a row, for the org-admin cross-venue check. */
export async function venueOrgId(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('org_id')
    .eq('id', venueId)
    .maybeSingle()
  return (data as { org_id: string | null } | null)?.org_id ?? null
}

/**
 * Revert a ledger row, or accept the legacy source (which is a revert
 * plus clearing the conflict flag across the wedding's live rows).
 *
 * Reverting the first-touch row would otherwise leave the wedding with
 * no first touch at all until a new signal arrived, so the recompute is
 * part of the action, not a follow-up.
 */
export async function revertAttributionEvent(
  supabase: SupabaseClient,
  row: AttributionEventRow,
  opts: { acceptLegacy: boolean; userId: string | null },
): Promise<ResolutionResult> {
  if (!row.reverted_at) {
    const { error } = await supabase
      .from('attribution_events')
      .update({
        reverted_at: new Date().toISOString(),
        reverted_by: opts.userId ?? null,
        reverted_reason: opts.acceptLegacy
          ? 'coordinator: legacy source wins'
          : 'coordinator: reverted',
      })
      .eq('id', row.id)
    if (error) return { ok: false, status: 500, error: error.message }
  }

  if (opts.acceptLegacy) {
    await supabase
      .from('attribution_events')
      .update({ conflict_with_legacy_source: null })
      .eq('wedding_id', row.wedding_id)
      .is('reverted_at', null)
  }

  const ft = await recomputeFirstTouch(supabase, row.wedding_id)
  if (ft.error) return { ok: false, status: 500, error: ft.error }

  // Connective tissue (gap C, 2026-04-30): the reverted attribution was
  // contributing to heat (cross-platform bonus, AI-tier bonus, funnel
  // weight). Recompute so the score matches the new live set. Best
  // effort — never roll back the revert because heat failed.
  try {
    await recalculateHeatScore(row.venue_id, row.wedding_id)
  } catch (err) {
    console.warn('[attribution revert] heat recalc failed:', err)
  }

  return { ok: true }
}

/**
 * Accept the computed first touch: overwrite the raw self-reported
 * source with the normalised computed platform and clear the conflict
 * flag on every live row for the wedding, because the coordinator's
 * decision settles the wedding, not one row.
 */
export async function acceptComputedSource(
  supabase: SupabaseClient,
  row: AttributionEventRow,
): Promise<ResolutionResult> {
  const computed = normalizeSource(row.source_platform)
  const { error } = await supabase
    .from('weddings')
    .update({ source: computed })
    .eq('id', row.wedding_id)
  if (error) return { ok: false, status: 500, error: error.message }

  await supabase
    .from('attribution_events')
    .update({ conflict_with_legacy_source: null })
    .eq('wedding_id', row.wedding_id)
    .is('reverted_at', null)

  return { ok: true, newSource: computed }
}
