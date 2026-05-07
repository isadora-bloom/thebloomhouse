/**
 * Attribution-parity cron service (T5-Rixey-BBB / BBB-4).
 *
 * Side-by-side validation of the legacy 7-tier chain
 * (`lead-source-derivation.ts` → `deriveLeadSourceForVenue`) against
 * the new identity-cluster compute
 * (`identity-cluster-attribution.ts` → `computeFirstTouchForVenue`).
 *
 * Writes one `attribution_parity_log` row per active wedding per run,
 * capturing:
 *   - chain_source     : canonical first-touch from the legacy chain
 *   - cluster_source   : canonical first-touch from the cluster compute
 *   - agree            : true iff both produced the same canonical value
 *   - detail jsonb     : cluster confidence / evidence count / etc.
 *
 * The `/intel/sources/parity` dashboard reads from this table to show
 * the agreement rate over time + drill into divergent rows.
 *
 * Runs at 05:30 UTC daily (vercel.json cron `compute_attribution_parity`)
 * — sequenced AFTER:
 *   - 03:30 backtrace_scan (Stream BBB legacy-chain re-runs)
 *   - 04:45 phase_b_sweep  (CCC candidate-resolver re-runs)
 *
 * Per the cutover playbook: USE_CLUSTER_FIRST_TOUCH flips ON only
 * when this dashboard shows >=90% agreement for 7 consecutive days
 * AND CCC has been running for >=48h.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeFirstTouchForVenue } from '@/lib/services/identity/cluster-attribution'
import { formatSourceLabel } from '@/lib/utils/format-source-label'

export interface VenueParityResult {
  venueId: string
  weddingsScanned: number
  agreed: number
  disagreed: number
  bothNull: number
  agreementRatePct: number
  errors: string[]
}

/**
 * Run the parity scan for a single venue. Reads `weddings.lead_source`
 * (the chain output) directly + computes the cluster output via
 * computeFirstTouchForVenue, then bulk-inserts one row per wedding
 * into attribution_parity_log.
 *
 * The chain output is read AS-IS from the column. The migration 187
 * adapter-as-facts cleanup + the daily attribution_refresh cron keep
 * `weddings.lead_source` fresh; we don't re-derive in this function
 * because doing so would obscure what coordinators actually see.
 */
export async function computeAttributionParityForVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueParityResult> {
  const result: VenueParityResult = {
    venueId,
    weddingsScanned: 0,
    agreed: 0,
    disagreed: 0,
    bothNull: 0,
    agreementRatePct: 0,
    errors: [],
  }

  // 1. Pull the chain output for every active wedding.
  const { data: chainRows, error: chainErr } = await supabase
    .from('weddings')
    .select('id, lead_source')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
  if (chainErr) {
    result.errors.push(`chain load: ${chainErr.message}`)
    return result
  }
  const chainByWedding = new Map<string, string | null>()
  for (const w of chainRows ?? []) {
    chainByWedding.set(w.id as string, (w.lead_source as string | null) ?? null)
  }

  // 2. Compute the cluster output for the same set.
  let clusterByWedding: Awaited<ReturnType<typeof computeFirstTouchForVenue>>
  try {
    clusterByWedding = await computeFirstTouchForVenue(supabase, venueId)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    result.errors.push(`cluster compute: ${m}`)
    return result
  }

  // 3. Build the parity rows.
  const computedAt = new Date().toISOString()
  const parityRows: Array<{
    venue_id: string
    wedding_id: string
    chain_source: string | null
    cluster_source: string | null
    agree: boolean
    detail: Record<string, unknown>
    computed_at: string
  }> = []

  for (const [wid, chainSource] of chainByWedding.entries()) {
    const clusterRes = clusterByWedding.get(wid)
    const clusterSource = clusterRes?.source ?? null

    // Canonicalise both sides through the same display formatter so
    // 'weddingwire' vs 'wedding_wire' aliases collapse to the same
    // label. The DB writes the lowercase canonical value (the chain
    // already normalises via normalizeSource); the display label is
    // the agreement key.
    const chainLabel = chainSource ? formatSourceLabel(chainSource) : null
    const clusterLabel = clusterSource ? formatSourceLabel(clusterSource) : null
    const agree = chainLabel === clusterLabel

    if (chainSource === null && clusterSource === null) result.bothNull++
    else if (agree) result.agreed++
    else result.disagreed++
    result.weddingsScanned++

    parityRows.push({
      venue_id: venueId,
      wedding_id: wid,
      chain_source: chainSource,
      cluster_source: clusterSource,
      agree,
      detail: {
        cluster_confidence: clusterRes?.confidence ?? null,
        cluster_total_signals: clusterRes?.totalSignalsInCluster ?? 0,
        cluster_total_source_signals: clusterRes?.totalSourceSignals ?? 0,
        cluster_override_used: clusterRes?.overrideUsed ?? false,
        chain_label: chainLabel,
        cluster_label: clusterLabel,
        evidence_count: (clusterRes?.evidence?.length ?? 0),
        evidence: (clusterRes?.evidence ?? []).slice(0, 5),
      },
      computed_at: computedAt,
    })
  }

  // 4. Bulk insert. Chunk to avoid PostgREST request-size cap.
  const CHUNK = 500
  for (let i = 0; i < parityRows.length; i += CHUNK) {
    const chunk = parityRows.slice(i, i + CHUNK)
    const { error } = await supabase.from('attribution_parity_log').insert(chunk)
    if (error) {
      result.errors.push(`parity log insert chunk ${i}: ${error.message}`)
    }
  }

  result.agreementRatePct =
    result.weddingsScanned > 0
      ? Math.round((100 * (result.agreed + result.bothNull)) / result.weddingsScanned)
      : 0

  return result
}

/**
 * Iterate active venues + run the parity scan against each.
 * Per-venue failures are caught and reported in the per-venue
 * result; the overall iterator never throws.
 */
export async function computeAttributionParityAllVenues(
  supabase: SupabaseClient,
): Promise<Record<string, VenueParityResult>> {
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')
  if (error) throw new Error(`venues load: ${error.message}`)
  const out: Record<string, VenueParityResult> = {}
  for (const v of venues ?? []) {
    const id = v.id as string
    try {
      out[id] = await computeAttributionParityForVenue(supabase, id)
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      out[id] = {
        venueId: id,
        weddingsScanned: 0,
        agreed: 0,
        disagreed: 0,
        bothNull: 0,
        agreementRatePct: 0,
        errors: [m],
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// USE_CLUSTER_FIRST_TOUCH feature flag
// ---------------------------------------------------------------------------
//
// The cutover gate (BBB-7). When OFF (default), the legacy chain
// continues to drive `weddings.lead_source` and read sites; the
// cluster compute only writes parity-log rows for review.
//
// When ON, callers should switch to `computeFirstTouchForCluster`
// for first-touch reads. This flag exists today; the wiring to flip
// behaviour ships with BBB-7. DO NOT enable until parity dashboard
// shows >=90% agreement for 7 consecutive days AND CCC has been
// running for >=48h.

export function useClusterFirstTouchEnabled(): boolean {
  return (process.env.USE_CLUSTER_FIRST_TOUCH ?? '').toLowerCase() === 'true'
}
