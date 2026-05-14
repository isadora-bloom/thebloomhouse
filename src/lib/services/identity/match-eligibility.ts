/**
 * Match-eligibility timeline gate.
 *
 * Anchor: Round 2 audit TIER 2a + agent-impact pass (2026-05-14).
 * The audit caught Zachary Gragan ↔ "zachary s." matched at 93%
 * confidence with signals 260 days apart. There was no global
 * "is this even possible" gate; per-platform tier-1 windows are
 * tight (72h-1w) but the full-name + AI paths could span ANY
 * window, and the resolver wrote rows for every signal regardless
 * of how far they sat from the wedding's anchor date.
 *
 * The gate: signals must fall within the venue's eligibility band
 * relative to the wedding's anchor (closest of inquiry / tour /
 * booked date). Out-of-band signals are dropped from the row set.
 * Exact-match tier is exempt (email/phone match is rock-solid).
 *
 * Band: default 180 days. Venue-tunable via
 * venue_config.match_eligibility_band_days. Manifest exposes the
 * effective value. Agent-impact pass: 90d (audit's first suggestion)
 * is too tight for Rixey where inquiry-to-tour averages 30-60d and
 * tour-to-book is another 30-90d.
 *
 * Why NOT mirrored in the email pipeline's wedding-find step
 * -----------------------------------------------------------
 * The agent-impact pass flagged that if we hard-capped at 90d, the
 * email pipeline could orphan-mint MORE weddings (signals outside
 * the band fall through to mint). We chose 180d default which is
 * WIDER than the pipeline's name+date join window (7 days in
 * resolver.ts:findByNamePlusDate). So this gate can never reject
 * something the pipeline would have matched — no mirror needed.
 * If the band is ever tightened below 30d, revisit this and add a
 * mirror in resolver.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_ELIGIBILITY_BAND_DAYS = 180

/**
 * Load the eligibility band for a venue. Cached per resolver pass
 * via the caller — we do not cache here because the resolver fans
 * out and a stale band during reconfiguration would be confusing.
 */
export async function getMatchEligibilityBandDays(
  supabase: SupabaseClient,
  venueId: string,
): Promise<number> {
  try {
    const { data } = await supabase
      .from('venue_config')
      .select('match_eligibility_band_days, identity_match_config')
      .eq('venue_id', venueId)
      .maybeSingle()
    const direct = (data as { match_eligibility_band_days?: number | null } | null)
      ?.match_eligibility_band_days
    if (typeof direct === 'number' && direct > 0) return direct

    // Fall back to identity_match_config.eligibility_band_days if
    // present in the venue's broader match config.
    const cfg = (data as { identity_match_config?: { eligibility_band_days?: number } } | null)
      ?.identity_match_config
    if (cfg && typeof cfg.eligibility_band_days === 'number' && cfg.eligibility_band_days > 0) {
      return cfg.eligibility_band_days
    }
  } catch {
    // Venue config table or columns may not have the field; fall
    // through to default.
  }
  return DEFAULT_ELIGIBILITY_BAND_DAYS
}

export interface SignalForEligibility {
  id: string
  signal_date: string | null
}

export interface WeddingAnchorDates {
  inquiry_date?: string | null
  tour_date?: string | null
  booked_at?: string | null
  last_interaction_at?: string | null
}

export interface EligibilityFilterResult<T> {
  eligible: T[]
  dropped: Array<{ signal: T; reason: string }>
}

/**
 * Filter signals to the eligibility band relative to the wedding's
 * anchor (closest of inquiry / tour / booked / last_interaction).
 *
 * Returns { eligible, dropped } so callers can decide whether to
 * proceed (some eligible signals remain) or abort (zero eligible).
 *
 * exempt=true skips the gate entirely — for tier_1_exact email/phone
 * matches where signal-date distance is irrelevant.
 */
export function filterSignalsByEligibility<T extends SignalForEligibility>(
  signals: T[],
  wedding: WeddingAnchorDates,
  bandDays: number,
  opts?: { exempt?: boolean },
): EligibilityFilterResult<T> {
  if (opts?.exempt) {
    return { eligible: signals, dropped: [] }
  }

  const anchors = collectAnchorTimestamps(wedding)
  if (anchors.length === 0) {
    // No anchor — can't compute distance. Keep everything; the rest
    // of the resolver's logic decides.
    return { eligible: signals, dropped: [] }
  }

  const bandMs = bandDays * 86400000
  const eligible: T[] = []
  const dropped: Array<{ signal: T; reason: string }> = []
  for (const s of signals) {
    if (!s.signal_date) {
      eligible.push(s)
      continue
    }
    const sigTs = new Date(s.signal_date).getTime()
    if (!Number.isFinite(sigTs)) {
      eligible.push(s)
      continue
    }
    // Minimum distance to any anchor.
    const minDist = anchors.reduce(
      (acc, a) => Math.min(acc, Math.abs(sigTs - a)),
      Number.POSITIVE_INFINITY,
    )
    if (minDist > bandMs) {
      const days = Math.round(minDist / 86400000)
      dropped.push({
        signal: s,
        reason: `signal ${days}d from nearest wedding anchor (band=${bandDays}d)`,
      })
      continue
    }
    eligible.push(s)
  }
  return { eligible, dropped }
}

function collectAnchorTimestamps(w: WeddingAnchorDates): number[] {
  const out: number[] = []
  const push = (v: string | null | undefined): void => {
    if (!v) return
    const t = new Date(v).getTime()
    if (Number.isFinite(t)) out.push(t)
  }
  push(w.inquiry_date)
  push(w.tour_date)
  push(w.booked_at)
  push(w.last_interaction_at)
  return out
}
