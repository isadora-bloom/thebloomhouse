/**
 * D1 heat — couple-keyed heat-score distribution + trajectory.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §C.5 (Tier 8 T8.2 remaining).
 * D9 ships couple-keyed funnel + timing; this is the heat-side parallel:
 * a deterministic read over couples + touchpoints that answers "where
 * does my engagement intensity sit, and which couples are at the
 * extremes today?"
 *
 * Honesty (§C.6 Tier 4): every cell carries its own n. The
 * distribution counts are raw counts (no honesty gate — counts are not
 * confident-sounding medians). The hottest / coldest lists carry the
 * couple's name + heat + lifecycle so the operator can sanity-check.
 *
 * Multi-venue safe. No Rixey-specific clauses.
 */

import type { CohortData } from './types'
import { ENGAGED_STATES } from './types'

// ---------------------------------------------------------------------------
// Heat bands
// ---------------------------------------------------------------------------

const HEAT_BANDS = [
  { label: 'Cold',   min: 0,  max: 19 },
  { label: 'Cool',   min: 20, max: 39 },
  { label: 'Warm',   min: 40, max: 59 },
  { label: 'Hot',    min: 60, max: 79 },
  { label: 'On fire', min: 80, max: Infinity },
] as const

type HeatBandLabel = (typeof HEAT_BANDS)[number]['label']

function labelFor(score: number | null): HeatBandLabel | null {
  if (score === null || !Number.isFinite(score)) return null
  for (const b of HEAT_BANDS) {
    if (score >= b.min && score <= b.max) return b.label
  }
  return null
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HeatBandCell {
  label: HeatBandLabel
  min: number
  max: number | null
  count: number
}

export interface HeatByLifecycleRow {
  lifecycleState: string
  count: number
  mean: number | null
  median: number | null
  /** Per-band breakdown so the surface can stack a single bar. */
  bands: HeatBandCell[]
}

export interface HeatTopRow {
  coupleId: string
  primaryName: string | null
  lifecycleState: string
  heatScore: number
  weddingDate: string | null
  touchpointCount: number
}

export interface HeatReport {
  totalCouples: number
  totalWithHeat: number
  meanHeat: number | null
  medianHeat: number | null
  bands: HeatBandCell[]
  byLifecycle: HeatByLifecycleRow[]
  /** 20 hottest active couples (engaged-state). */
  hottestActive: HeatTopRow[]
  /** 20 coldest active couples — engaged-state with the lowest heat. */
  coldestActive: HeatTopRow[]
  /** Active couples (resolved / booked / ghost) whose heat is 0 OR
   *  null — Bloom is engaged but the heat engine hasn't scored them
   *  yet. Surfaced as a count for honesty. */
  activeWithNoHeat: number
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function emptyBands(): HeatBandCell[] {
  return HEAT_BANDS.map((b) => ({
    label: b.label,
    min: b.min,
    max: Number.isFinite(b.max) ? b.max : null,
    count: 0,
  }))
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  if (sortedAsc.length === 1) return sortedAsc[0]
  const rank = (p / 100) * (sortedAsc.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  const frac = rank - lo
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function buildHeatReport(data: CohortData): HeatReport {
  // Index touchpoints by couple for the top-list touchpointCount column.
  const tpCountByCouple = new Map<string, number>()
  for (const tp of data.touchpoints) {
    if (!tp.couple_id) continue
    tpCountByCouple.set(tp.couple_id, (tpCountByCouple.get(tp.couple_id) ?? 0) + 1)
  }

  const totalCouples = data.couples.length
  const withHeat = data.couples.filter(
    (c) => c.heat_score !== null && Number.isFinite(c.heat_score),
  )
  const totalWithHeat = withHeat.length

  // Overall distribution + summary.
  const allScores = withHeat
    .map((c) => Number(c.heat_score))
    .sort((a, b) => a - b)
  const meanHeat =
    allScores.length > 0
      ? allScores.reduce((s, v) => s + v, 0) / allScores.length
      : null
  const medianHeat = percentile(allScores, 50)

  // Bands across the whole population (incl. channel_scoped — useful
  // to see the noise floor).
  const bands = emptyBands()
  for (const c of withHeat) {
    const lbl = labelFor(c.heat_score)
    if (!lbl) continue
    const cell = bands.find((b) => b.label === lbl)
    if (cell) cell.count += 1
  }

  // By-lifecycle crosstab.
  const byLifecycleMap = new Map<string, {
    count: number
    scores: number[]
    bands: HeatBandCell[]
  }>()
  for (const c of data.couples) {
    const entry = byLifecycleMap.get(c.lifecycle_state) ?? {
      count: 0,
      scores: [],
      bands: emptyBands(),
    }
    entry.count += 1
    if (c.heat_score !== null && Number.isFinite(c.heat_score)) {
      entry.scores.push(Number(c.heat_score))
      const lbl = labelFor(c.heat_score)
      if (lbl) {
        const cell = entry.bands.find((b) => b.label === lbl)
        if (cell) cell.count += 1
      }
    }
    byLifecycleMap.set(c.lifecycle_state, entry)
  }
  const byLifecycle: HeatByLifecycleRow[] = []
  for (const [state, entry] of byLifecycleMap) {
    const sorted = entry.scores.slice().sort((a, b) => a - b)
    byLifecycle.push({
      lifecycleState: state,
      count: entry.count,
      mean:
        sorted.length > 0
          ? sorted.reduce((s, v) => s + v, 0) / sorted.length
          : null,
      median: percentile(sorted, 50),
      bands: entry.bands,
    })
  }
  // Order: engaged states first, then channel_scoped, then anything else.
  const STATE_ORDER = ['resolved', 'booked', 'ghost', 'channel_scoped']
  byLifecycle.sort((a, b) => {
    const ai = STATE_ORDER.indexOf(a.lifecycleState)
    const bi = STATE_ORDER.indexOf(b.lifecycleState)
    if (ai === -1 && bi === -1) return a.lifecycleState.localeCompare(b.lifecycleState)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  // Hottest / coldest active lists. "Active" = engaged-state.
  const active = data.couples.filter((c) =>
    (ENGAGED_STATES as readonly string[]).includes(c.lifecycle_state),
  )
  const activeWithHeat = active.filter(
    (c) => c.heat_score !== null && Number.isFinite(c.heat_score) && Number(c.heat_score) > 0,
  )
  const activeWithNoHeat = active.length - activeWithHeat.length

  const sortedActive = activeWithHeat
    .slice()
    .sort((a, b) => Number(b.heat_score) - Number(a.heat_score))

  function toRow(c: CohortData['couples'][number]): HeatTopRow {
    return {
      coupleId: c.id,
      primaryName: c.primary_contact_name ?? null,
      lifecycleState: c.lifecycle_state,
      heatScore: Number(c.heat_score ?? 0),
      weddingDate: c.wedding_date ?? null,
      touchpointCount: tpCountByCouple.get(c.id) ?? 0,
    }
  }

  return {
    totalCouples,
    totalWithHeat,
    meanHeat,
    medianHeat,
    bands,
    byLifecycle,
    hottestActive: sortedActive.slice(0, 20).map(toRow),
    coldestActive: sortedActive.slice(-20).reverse().map(toRow),
    activeWithNoHeat,
  }
}
