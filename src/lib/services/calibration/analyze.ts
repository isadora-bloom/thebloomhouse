/**
 * Wave 18 — Calibration analyzer.
 *
 * Anchor: feedback_measure_dont_assume.md
 *
 * What this module does
 * ---------------------
 * Given a (venue, prediction kind, window-in-days), computes:
 *
 *   - Brier score: mean squared difference between predicted
 *     probability (0-1) and actual outcome (0 or 1). Lower is better;
 *     0 = perfect, 0.25 = random for a balanced 50/50 prior.
 *
 *   - Reliability diagram bins: 10 deciles of predicted probability,
 *     each with (a) count of snapshots in the bin, (b) average
 *     predicted probability inside the bin, (c) actual booking rate
 *     inside the bin. A well-calibrated model has y=x (predicted
 *     average ≈ actual rate).
 *
 *   - Per-persona calibration: same metrics broken down by the
 *     persona_label snapshotted on the wedding's couple_intel at the
 *     time of measurement. (We join through couple_intel; not
 *     historical because the persona is allowed to drift.)
 *
 *   - Drift: Brier score and accuracy computed in three rolling
 *     windows (last 30d, last 90d, last 365d) so the dashboard can
 *     visualise "is the model getting better or worse over time".
 *
 *   - Above-50 accuracy / below-50 accuracy: simple "did we get the
 *     direction right?" numbers, easier for operators to grok than
 *     Brier.
 *
 * Persona lookup
 * --------------
 * Persona is read from couple_intel.persona_label at analyze time —
 * NOT historical at snapshot time. We don't snapshot persona because
 * the prediction model itself takes persona as input, so persona at
 * derive time IS already encoded in the prediction. What we want for
 * the breakdown is: "for couples who are currently labelled X, how
 * well are our predictions calibrated?" — which uses current persona.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEFAULT_WINDOW_DAYS = 90
const PERSONA_MIN_N = 5
const BIN_COUNT = 10

export interface CalibrationBin {
  /** Lower edge of the predicted-probability decile, 0-100. */
  predictedFloor: number
  /** Upper edge of the predicted-probability decile, 0-100. */
  predictedCeil: number
  /** Count of snapshots in the bin. */
  count: number
  /** Average predicted probability in the bin, 0-100. */
  avgPredicted: number | null
  /** Actual booking rate in the bin, 0-100. */
  actualBookedRate: number | null
}

export interface PersonaCalibrationRow {
  persona: string
  n: number
  brierScore: number | null
  accuracyPct: number | null
  avgPredictedPct: number | null
  avgActualPct: number | null
}

export interface DriftWindowRow {
  windowLabel: '30d' | '90d' | '365d'
  windowDays: number
  n: number
  brierScore: number | null
  accuracyPct: number | null
  above50AccuracyPct: number | null
  below50AccuracyPct: number | null
}

export interface CalibrationReport {
  venueId: string
  kind: string
  windowDays: number
  generatedAt: string

  /** Total snapshot+outcome pairs in the window. */
  n: number
  /** Mean Brier score across the window. Lower is better. NULL if n=0. */
  brierScore: number | null
  /** % of predictions where match was correct (predicted-direction == actual). */
  accuracyPct: number | null
  /** Of predictions >= 50, % that actually booked. */
  above50AccuracyPct: number | null
  /** Of predictions < 50, % that actually did NOT book. */
  below50AccuracyPct: number | null
  /** Sum of |error|/N — average error magnitude. */
  meanAbsoluteErrorPct: number | null

  /** 10 reliability bins. */
  reliabilityBins: CalibrationBin[]

  /** Per-persona breakdown for personas with >= PERSONA_MIN_N samples. */
  perPersona: PersonaCalibrationRow[]

  /** Drift across rolling windows (30d / 90d / 365d). */
  drift: DriftWindowRow[]

  /** Diagnostics for the dashboard — how many snapshots vs outcomes. */
  diagnostics: {
    snapshotsTotal: number
    outcomesTotal: number
    pendingMeasurement: number
    sufficientForAnalysis: boolean
  }
}

export interface AnalyzeCalibrationArgs {
  venueId: string
  kind?: string
  windowDays?: number
  supabase?: SupabaseClient
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JoinedRow {
  snapshot_id: string
  wedding_id: string
  predicted_pct: number
  measured_at: string
  matched: boolean
  error_magnitude: number
  actual_booked: boolean
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function safeDivide(a: number, b: number): number | null {
  if (b === 0) return null
  return a / b
}

function brierForRows(rows: JoinedRow[]): number | null {
  if (rows.length === 0) return null
  let sum = 0
  for (const r of rows) {
    const predicted = r.predicted_pct / 100
    const actual = r.actual_booked ? 1 : 0
    sum += (predicted - actual) ** 2
  }
  return sum / rows.length
}

function accuracyForRows(rows: JoinedRow[]): number | null {
  if (rows.length === 0) return null
  const correct = rows.filter((r) => r.matched).length
  return (correct / rows.length) * 100
}

function above50Accuracy(rows: JoinedRow[]): number | null {
  const above = rows.filter((r) => r.predicted_pct >= 50)
  if (above.length === 0) return null
  const correct = above.filter((r) => r.actual_booked).length
  return (correct / above.length) * 100
}

function below50Accuracy(rows: JoinedRow[]): number | null {
  const below = rows.filter((r) => r.predicted_pct < 50)
  if (below.length === 0) return null
  const correct = below.filter((r) => !r.actual_booked).length
  return (correct / below.length) * 100
}

function meanAbsoluteError(rows: JoinedRow[]): number | null {
  if (rows.length === 0) return null
  let sum = 0
  for (const r of rows) sum += r.error_magnitude
  return sum / rows.length
}

function buildReliabilityBins(rows: JoinedRow[]): CalibrationBin[] {
  const bins: CalibrationBin[] = []
  for (let i = 0; i < BIN_COUNT; i++) {
    const floor = i * (100 / BIN_COUNT)
    const ceil = (i + 1) * (100 / BIN_COUNT)
    // last bin is inclusive on the high end so 100% predictions land
    // somewhere.
    const inBin = rows.filter((r) =>
      i === BIN_COUNT - 1
        ? r.predicted_pct >= floor && r.predicted_pct <= ceil
        : r.predicted_pct >= floor && r.predicted_pct < ceil,
    )
    let avgPredicted: number | null = null
    let actualBookedRate: number | null = null
    if (inBin.length > 0) {
      avgPredicted =
        inBin.reduce((acc, r) => acc + r.predicted_pct, 0) / inBin.length
      const booked = inBin.filter((r) => r.actual_booked).length
      actualBookedRate = (booked / inBin.length) * 100
    }
    bins.push({
      predictedFloor: floor,
      predictedCeil: ceil,
      count: inBin.length,
      avgPredicted,
      actualBookedRate,
    })
  }
  return bins
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface SnapshotJoinRow {
  id: string
  wedding_id: string
  venue_id: string
  prediction_kind: string
  predicted_value: Record<string, unknown>
  snapshotted_at: string
}

interface OutcomeJoinRow {
  id: string
  prediction_snapshot_id: string | null
  wedding_id: string
  matched_prediction: boolean | null
  error_magnitude: number | string | null
  actual_outcome: Record<string, unknown> | null
  measured_at: string
}

async function loadJoinedRows(
  supabase: SupabaseClient,
  venueId: string,
  kind: string,
  sinceIso: string,
): Promise<JoinedRow[]> {
  // PostgREST doesn't make composite-join easy from the JS client.
  // Pull snapshots + outcomes in two queries scoped by venue + kind +
  // window and join in memory. Volume is bounded by how many couples
  // a venue books per quarter; expect tens to low-thousands at most.
  const { data: outcomes, error: oErr } = await supabase
    .from('prediction_outcomes')
    .select(
      'id, prediction_snapshot_id, wedding_id, matched_prediction, error_magnitude, actual_outcome, measured_at',
    )
    .eq('venue_id', venueId)
    .gte('measured_at', sinceIso)
    .limit(5000)
  if (oErr) throw new Error(`outcomes fetch failed: ${oErr.message}`)
  if (!outcomes || outcomes.length === 0) return []

  const snapIds = (outcomes as OutcomeJoinRow[])
    .map((o) => o.prediction_snapshot_id)
    .filter((v): v is string => typeof v === 'string')
  if (snapIds.length === 0) return []

  const { data: snapshots, error: sErr } = await supabase
    .from('prediction_snapshots')
    .select(
      'id, wedding_id, venue_id, prediction_kind, predicted_value, snapshotted_at',
    )
    .in('id', snapIds)
    .eq('prediction_kind', kind)
  if (sErr) throw new Error(`snapshots fetch failed: ${sErr.message}`)
  if (!snapshots) return []

  const snapMap = new Map<string, SnapshotJoinRow>(
    (snapshots as SnapshotJoinRow[]).map((s) => [s.id, s]),
  )

  const rows: JoinedRow[] = []
  for (const o of outcomes as OutcomeJoinRow[]) {
    if (!o.prediction_snapshot_id) continue
    const snap = snapMap.get(o.prediction_snapshot_id)
    if (!snap) continue
    const predicted = asNumber(snap.predicted_value.pct_0_100)
    if (predicted === null) continue
    const actualBooked = o.actual_outcome
      ? !!(o.actual_outcome.booked as boolean | undefined)
      : false
    rows.push({
      snapshot_id: snap.id,
      wedding_id: snap.wedding_id,
      predicted_pct: predicted,
      measured_at: o.measured_at,
      matched: !!o.matched_prediction,
      error_magnitude: Number(o.error_magnitude ?? 0),
      actual_booked: actualBooked,
    })
  }
  return rows
}

async function loadPersonaMap(
  supabase: SupabaseClient,
  weddingIds: string[],
): Promise<Map<string, string>> {
  if (weddingIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('couple_intel')
    .select('wedding_id, persona_label')
    .in('wedding_id', weddingIds)
  if (error || !data) return new Map()
  const m = new Map<string, string>()
  for (const r of data as Array<{ wedding_id: string; persona_label: string | null }>) {
    m.set(r.wedding_id, r.persona_label ?? '__untagged__')
  }
  return m
}

async function countSnapshotsAndPending(
  supabase: SupabaseClient,
  venueId: string,
  kind: string,
): Promise<{ snapshotsTotal: number; outcomesTotal: number; pending: number }> {
  // Total snapshots in the venue (across all time — diagnostic).
  const { count: snapshotsTotal } = await supabase
    .from('prediction_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('prediction_kind', kind)
  const { count: outcomesTotal } = await supabase
    .from('prediction_outcomes')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  return {
    snapshotsTotal: snapshotsTotal ?? 0,
    outcomesTotal: outcomesTotal ?? 0,
    pending: Math.max(0, (snapshotsTotal ?? 0) - (outcomesTotal ?? 0)),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function analyzeCalibration(
  args: AnalyzeCalibrationArgs,
): Promise<CalibrationReport> {
  const supabase = args.supabase ?? createServiceClient()
  const kind = args.kind ?? 'close_probability_pct'
  const windowDays =
    typeof args.windowDays === 'number' && args.windowDays > 0
      ? Math.min(3650, Math.floor(args.windowDays))
      : DEFAULT_WINDOW_DAYS

  const now = Date.now()
  const sinceIso = new Date(now - windowDays * 86_400_000).toISOString()

  const rows = await loadJoinedRows(supabase, args.venueId, kind, sinceIso)

  // Headline metrics.
  const n = rows.length
  const brierScore = brierForRows(rows)
  const accuracyPct = accuracyForRows(rows)
  const above50Pct = above50Accuracy(rows)
  const below50Pct = below50Accuracy(rows)
  const meanAbsErr = meanAbsoluteError(rows)

  // Reliability diagram.
  const reliabilityBins = buildReliabilityBins(rows)

  // Per-persona breakdown.
  const weddingIds = Array.from(new Set(rows.map((r) => r.wedding_id)))
  const personaMap = await loadPersonaMap(supabase, weddingIds)
  const byPersona = new Map<string, JoinedRow[]>()
  for (const r of rows) {
    const p = personaMap.get(r.wedding_id) ?? '__untagged__'
    if (!byPersona.has(p)) byPersona.set(p, [])
    byPersona.get(p)!.push(r)
  }
  const perPersona: PersonaCalibrationRow[] = []
  for (const [persona, prows] of byPersona) {
    if (prows.length < PERSONA_MIN_N) continue
    const avgPredicted = prows.reduce((a, r) => a + r.predicted_pct, 0) / prows.length
    const avgActual =
      (prows.filter((r) => r.actual_booked).length / prows.length) * 100
    perPersona.push({
      persona,
      n: prows.length,
      brierScore: brierForRows(prows),
      accuracyPct: accuracyForRows(prows),
      avgPredictedPct: Number(avgPredicted.toFixed(1)),
      avgActualPct: Number(avgActual.toFixed(1)),
    })
  }
  perPersona.sort((a, b) => b.n - a.n)

  // Drift across rolling windows. Re-query for each window to keep the
  // logic uniform.
  const driftWindowSpecs: Array<{ label: '30d' | '90d' | '365d'; days: number }> = [
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
    { label: '365d', days: 365 },
  ]
  const drift: DriftWindowRow[] = []
  for (const spec of driftWindowSpecs) {
    const driftSince = new Date(now - spec.days * 86_400_000).toISOString()
    // Optimisation: if windowDays already covers this window, reuse
    // the loaded rows. Otherwise reload.
    let driftRows: JoinedRow[]
    if (windowDays >= spec.days) {
      driftRows = rows.filter((r) => r.measured_at >= driftSince)
    } else {
      driftRows = await loadJoinedRows(supabase, args.venueId, kind, driftSince)
    }
    drift.push({
      windowLabel: spec.label,
      windowDays: spec.days,
      n: driftRows.length,
      brierScore: brierForRows(driftRows),
      accuracyPct: accuracyForRows(driftRows),
      above50AccuracyPct: above50Accuracy(driftRows),
      below50AccuracyPct: below50Accuracy(driftRows),
    })
  }

  // Diagnostics.
  const { snapshotsTotal, outcomesTotal, pending } = await countSnapshotsAndPending(
    supabase,
    args.venueId,
    kind,
  )

  return {
    venueId: args.venueId,
    kind,
    windowDays,
    generatedAt: new Date().toISOString(),
    n,
    brierScore: brierScore !== null ? Number(brierScore.toFixed(4)) : null,
    accuracyPct: accuracyPct !== null ? Number(accuracyPct.toFixed(1)) : null,
    above50AccuracyPct: above50Pct !== null ? Number(above50Pct.toFixed(1)) : null,
    below50AccuracyPct: below50Pct !== null ? Number(below50Pct.toFixed(1)) : null,
    meanAbsoluteErrorPct: meanAbsErr !== null ? Number(meanAbsErr.toFixed(2)) : null,
    reliabilityBins,
    perPersona,
    drift,
    diagnostics: {
      snapshotsTotal,
      outcomesTotal,
      pendingMeasurement: pending,
      // We surface "sufficient" at n >= 20 — a coarse rule of thumb
      // for Brier-score stability. Below that the metric is noisy.
      sufficientForAnalysis: n >= 20,
    },
  }
}
// Suppress unused-warning for the safeDivide helper kept for future
// metric additions.
void safeDivide
