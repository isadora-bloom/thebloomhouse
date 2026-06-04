/**
 * Ghost-risk — "which active couples are most likely to go quiet, and WHY"
 * (battery Q19: a predictive question that REQUIRES transparency).
 *
 * Doctrine: we do NOT emit a fabricated probability. We rank active couples
 * by transparent, sourced risk signals and return the EVIDENCE behind each
 * rank, so an operator (or Sage) can see exactly why a couple is flagged.
 *
 * Two sourced signals (no invented model):
 *   1. Decay proximity — how far through the couple's decay window it has
 *      gone quiet. Window arithmetic + the 0.75 "going cold" fraction match
 *      decay.ts / getDailyList.goingCold. Past the full window the couple is
 *      already ghosted (decay sweep handles it), so risk peaks just before.
 *   2. Heat level — the time-decayed engagement score (heat-score.ts), with
 *      its top contribution surfaced as the strongest piece of evidence.
 *
 * Only ACTIVE couples (resolved / channel_scoped) are assessed — booked /
 * ghost / completed / agent are out of scope by definition.
 */

import {
  computeHeatBreakdown,
  heatBucket,
  type HeatTouchpoint,
  type HeatBucket,
} from '@/lib/services/identity/heat-score'

/** 0.75 of the decay window = "going cold" — same threshold as getDailyList. */
const COLD_FRACTION = 0.75
const DEFAULT_WINDOW_DAYS = 180

export interface GhostRiskCoupleInput {
  id: string
  primaryContactName: string | null
  partnerContactName: string | null
  lifecycleState: string | null
  lastProgressionAt: string | null
  decayWindowDays: number | null
}

export interface GhostRiskAssessment {
  coupleId: string
  names: string | null
  /** Coarse rank only — the evidence is `signals`. */
  riskTier: 'high' | 'medium' | 'low'
  daysQuiet: number | null
  decayFraction: number | null
  heatScore: number
  heatBucket: HeatBucket
  /** Human-readable evidence — the WHY. Always populated. */
  signals: string[]
}

function names(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

const ACTIVE = new Set(['resolved', 'channel_scoped'])

/**
 * Assess one couple's ghost risk from its touchpoints. Returns null for
 * couples not in scope (booked/ghost/completed/agent). Pure + deterministic.
 */
export function assessGhostRisk(
  couple: GhostRiskCoupleInput,
  touchpoints: HeatTouchpoint[],
  now = Date.now(),
): GhostRiskAssessment | null {
  if (!ACTIVE.has(couple.lifecycleState ?? '')) return null

  const { score, contributions } = computeHeatBreakdown(touchpoints, now)
  const bucket = heatBucket(score)
  const signals: string[] = []

  // Signal 1 — decay proximity.
  let daysQuiet: number | null = null
  let decayFraction: number | null = null
  const windowDays = couple.decayWindowDays ?? DEFAULT_WINDOW_DAYS
  if (couple.lastProgressionAt) {
    const ageMs = now - Date.parse(couple.lastProgressionAt)
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      daysQuiet = Math.round(ageMs / 86_400_000)
      decayFraction = Math.round((daysQuiet / windowDays) * 100) / 100
      if (decayFraction >= COLD_FRACTION && decayFraction < 1) {
        signals.push(`Quiet ${daysQuiet}d of a ${windowDays}d decay window (${Math.round(decayFraction * 100)}%) — approaching auto-ghost`)
      } else if (decayFraction >= COLD_FRACTION) {
        signals.push(`Quiet ${daysQuiet}d — past the ${windowDays}d decay window`)
      }
    }
  } else {
    signals.push('No recorded inbound progression yet')
  }

  // Signal 2 — heat level + strongest contributing touchpoint.
  if (contributions.length === 0) {
    signals.push('No scoring touchpoints — engagement is unevidenced')
  } else if (bucket === 'cool' || bucket === 'warm') {
    const top = contributions[0]
    signals.push(`Heat is ${bucket} (score ${Math.round(score)}); strongest signal: ${top.signalTier} ${top.ageDays}d ago`)
  }

  // Coarse tier from the two signals (the list above is the real output).
  const cold = decayFraction !== null && decayFraction >= COLD_FRACTION
  const lowHeat = bucket === 'cool' || bucket === 'warm'
  const riskTier: GhostRiskAssessment['riskTier'] =
    cold && lowHeat ? 'high' : cold || lowHeat ? 'medium' : 'low'

  return {
    coupleId: couple.id,
    names: names(couple.primaryContactName, couple.partnerContactName),
    riskTier,
    daysQuiet,
    decayFraction,
    heatScore: Math.round(score * 10) / 10,
    heatBucket: bucket,
    signals,
  }
}

// ---------------------------------------------------------------------------
// Reader — spine-only, injectable (mirrors loadDailyList). Returns active
// couples ranked by ghost risk, highest first, capped.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

const RISK_LIMIT = 25
const TIER_RANK: Record<GhostRiskAssessment['riskTier'], number> = { high: 2, medium: 1, low: 0 }

interface GhostCoupleRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
  last_progression_at: string | null
  decay_window_days: number | null
}
interface GhostTpRow {
  couple_id: string | null
  signal_tier: string
  occurred_at: string
}

export async function loadGhostRisk(
  supabase: SupabaseClient,
  venueId: string,
  now = Date.now(),
): Promise<GhostRiskAssessment[]> {
  if (!venueId) return []

  const { data: coupleData } = await supabase
    .from('couples')
    .select('id, primary_contact_name, partner_contact_name, lifecycle_state, last_progression_at, decay_window_days')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .in('lifecycle_state', ['resolved', 'channel_scoped'])
    .limit(5000)
  const couples = (coupleData ?? []) as GhostCoupleRow[]
  if (couples.length === 0) return []

  const byId = new Set(couples.map((c) => c.id))
  const tpByCouple = new Map<string, HeatTouchpoint[]>()
  const { data: tpData } = await supabase
    .from('touchpoints')
    .select('couple_id, signal_tier, occurred_at')
    .eq('venue_id', venueId)
    .limit(20000)
  for (const t of (tpData ?? []) as GhostTpRow[]) {
    if (!t.couple_id || !byId.has(t.couple_id)) continue
    const arr = tpByCouple.get(t.couple_id)
    if (arr) arr.push({ signal_tier: t.signal_tier, occurred_at: t.occurred_at })
    else tpByCouple.set(t.couple_id, [{ signal_tier: t.signal_tier, occurred_at: t.occurred_at }])
  }

  const assessed: GhostRiskAssessment[] = []
  for (const c of couples) {
    const a = assessGhostRisk(
      {
        id: c.id,
        primaryContactName: c.primary_contact_name,
        partnerContactName: c.partner_contact_name,
        lifecycleState: c.lifecycle_state,
        lastProgressionAt: c.last_progression_at,
        decayWindowDays: c.decay_window_days,
      },
      tpByCouple.get(c.id) ?? [],
      now,
    )
    if (a && a.riskTier !== 'low') assessed.push(a)
  }

  assessed.sort((x, y) => {
    const t = TIER_RANK[y.riskTier] - TIER_RANK[x.riskTier]
    if (t !== 0) return t
    return (y.decayFraction ?? 0) - (x.decayFraction ?? 0)
  })
  return assessed.slice(0, RISK_LIMIT)
}
