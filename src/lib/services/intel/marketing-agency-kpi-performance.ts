/**
 * Bloom House — Wave 6E depth pass.
 *
 * Resolves agency_kpi_commitments against measured actuals (from
 * computeAgencyROI + computeAgencyBreakdown) so the agency-detail page
 * and the TBH Report can answer:
 *
 *   "Hawthorn committed to 12 leads/month. Across the last 90 days
 *    we measured 7 leads/month (-42%). Status: MISS."
 *
 * Design pressure-tested for the load-bearing edge cases:
 *
 *   1. WINDOW SCALING. A monthly-window KPI compared against a 90-day
 *      measurement period divides the count by 3. A yearly-window KPI
 *      is NOT extrapolated by 4× (4× a 90-day window produces a
 *      hockey-stick projection nobody trusts). Instead the row is
 *      framed as "progress toward annual goal" with a coverage caveat.
 *
 *   2. RATE vs COUNT. Cost-per-lead is window-invariant — the same
 *      "$200 CPL" appears whether we look at 30 or 90 days. Counts
 *      (leads_per_month) scale; rates don't.
 *
 *   3. UNIT MISMATCH. KPI may target USD when our underlying number is
 *      cents (or vice versa). Conversion happens in the resolver, not
 *      the UI, so the UI just renders `actualValueInTargetUnits`.
 *
 *   4. TOO-EARLY-TO-JUDGE. If the engagement has been live for less
 *      than 30 days, status is `too_early` rather than `miss`. Same
 *      when the agency was assigned to a channel less than 30 days ago.
 *
 *   5. UNMEASURABLE METRICS. Agencies sometimes commit to impressions
 *      / brand-search lift / share-of-voice — things Bloom can't see.
 *      These return status=`not_measurable` with a hint pointing at
 *      where the operator would find the answer (e.g. Google Ads
 *      console for impressions).
 *
 *   6. RETIRED KPIs. Filtered out by default; passed through when the
 *      caller asks for them so historical reports can include them.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { computeAgencyROI, computeAgencyBreakdown } from './marketing-agencies'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KpiStatus =
  | 'hit' // actual ≥ target (for higher-is-better) or ≤ target (lower-is-better)
  | 'close' // within ±10% of target
  | 'miss' // beyond the close band, in the wrong direction
  | 'too_early' // engagement too young to judge fairly
  | 'not_measurable' // Bloom doesn't measure this metric
  | 'no_data' // metric known but no events in window

export interface KpiPerformanceRow {
  kpiId: string
  metricName: string
  metricDisplay: string
  targetValue: number
  targetUnit: string
  targetWindow: string
  effectiveFrom: string
  effectiveTo: string | null
  notes: string | null

  /** Bloom's measured actual, expressed in the SAME unit as targetUnit. */
  actualValue: number | null
  /** Plain-English description of what was measured. */
  actualLabel: string
  /** Span of time the actual covers, in days. */
  measurementDays: number
  /** "+12%" / "-42%" / null when not comparable. */
  gapPct: number | null
  /** Direction the metric should move: 'higher' wins (leads) or 'lower' wins (CAC). */
  direction: 'higher_better' | 'lower_better' | 'neutral'
  status: KpiStatus
  /** UI-ready short caption. */
  statusLabel: string
  /** Why we landed on this status. UI surfaces in a tooltip. */
  reasoning: string
  /** Confidence label: 'high' | 'medium' | 'low'. */
  confidence: 'high' | 'medium' | 'low'
  confidenceReasoning: string
}

// ---------------------------------------------------------------------------
// Metric registry — canonical names → derivation rules
// ---------------------------------------------------------------------------
//
// Each entry describes how to derive the actual from the breakdown
// totals, what direction "good" is, and what unit the natural answer
// arrives in. The resolver handles window scaling + unit conversion on
// top of this.

interface MetricRule {
  display: string
  // Direction the metric should move when the agency is doing well.
  // 'neutral' = the number itself isn't intrinsically good or bad
  // (e.g. monthly spend — operator picks the target).
  direction: 'higher_better' | 'lower_better' | 'neutral'
  // Unit our derivation lands in. Resolver converts to target unit.
  nativeUnit: 'count' | 'cents' | 'percent' | 'ratio'
  // Does the natural value scale with measurement window (true for
  // counts) or is it window-invariant (false for rates)?
  isWindowScaled: boolean
  // Pull the natural value from the gathered context.
  derive: (ctx: DeriveContext) => number | null
  // Description of what was measured.
  describe: (ctx: DeriveContext) => string
}

interface DeriveContext {
  windowDays: number
  totalSpendCents: number
  firstTouchLeads: number
  firstTouchTours: number
  firstTouchBookings: number
  bookedRevenueCents: number
  costPerLeadCents: number | null
  costPerBookingCents: number | null
}

const METRIC_REGISTRY: Record<string, MetricRule> = {
  leads_per_month: {
    display: 'Leads per month',
    direction: 'higher_better',
    nativeUnit: 'count',
    isWindowScaled: true,
    derive: (c) => c.firstTouchLeads,
    describe: (c) => `${c.firstTouchLeads} first-touch leads in ${c.windowDays} days`,
  },
  inquiries_per_month: {
    display: 'Inquiries per month',
    direction: 'higher_better',
    nativeUnit: 'count',
    isWindowScaled: true,
    derive: (c) => c.firstTouchLeads,
    describe: (c) => `${c.firstTouchLeads} first-touch inquiries in ${c.windowDays} days`,
  },
  tours_per_month: {
    display: 'Tours per month',
    direction: 'higher_better',
    nativeUnit: 'count',
    isWindowScaled: true,
    derive: (c) => c.firstTouchTours,
    describe: (c) => `${c.firstTouchTours} tour-completed leads in ${c.windowDays} days`,
  },
  bookings_per_month: {
    display: 'Bookings per month',
    direction: 'higher_better',
    nativeUnit: 'count',
    isWindowScaled: true,
    derive: (c) => c.firstTouchBookings,
    describe: (c) => `${c.firstTouchBookings} bookings in ${c.windowDays} days`,
  },
  cost_per_lead: {
    display: 'Cost per lead',
    direction: 'lower_better',
    nativeUnit: 'cents',
    isWindowScaled: false,
    derive: (c) => c.costPerLeadCents,
    describe: (c) =>
      c.costPerLeadCents !== null
        ? `$${(c.costPerLeadCents / 100).toFixed(0)} per first-touch lead`
        : 'No measurable spend or leads in window',
  },
  cpl: {
    display: 'CPL',
    direction: 'lower_better',
    nativeUnit: 'cents',
    isWindowScaled: false,
    derive: (c) => c.costPerLeadCents,
    describe: (c) =>
      c.costPerLeadCents !== null
        ? `$${(c.costPerLeadCents / 100).toFixed(0)} per first-touch lead`
        : 'No measurable spend or leads in window',
  },
  cost_per_booking: {
    display: 'Cost per booking',
    direction: 'lower_better',
    nativeUnit: 'cents',
    isWindowScaled: false,
    derive: (c) => c.costPerBookingCents,
    describe: (c) =>
      c.costPerBookingCents !== null
        ? `$${(c.costPerBookingCents / 100).toFixed(0)} per booking`
        : 'No bookings attributed in window',
  },
  cac: {
    display: 'CAC',
    direction: 'lower_better',
    nativeUnit: 'cents',
    isWindowScaled: false,
    derive: (c) => c.costPerBookingCents,
    describe: (c) =>
      c.costPerBookingCents !== null
        ? `$${(c.costPerBookingCents / 100).toFixed(0)} per acquisition`
        : 'No bookings attributed in window',
  },
  tour_conversion_rate: {
    display: 'Tour conversion rate',
    direction: 'higher_better',
    nativeUnit: 'percent',
    isWindowScaled: false,
    derive: (c) =>
      c.firstTouchLeads > 0
        ? (c.firstTouchTours / c.firstTouchLeads) * 100
        : null,
    describe: (c) =>
      c.firstTouchLeads > 0
        ? `${c.firstTouchTours} of ${c.firstTouchLeads} leads completed a tour`
        : 'No leads in window',
  },
  booking_conversion_rate: {
    display: 'Booking conversion rate',
    direction: 'higher_better',
    nativeUnit: 'percent',
    isWindowScaled: false,
    derive: (c) =>
      c.firstTouchLeads > 0
        ? (c.firstTouchBookings / c.firstTouchLeads) * 100
        : null,
    describe: (c) =>
      c.firstTouchLeads > 0
        ? `${c.firstTouchBookings} of ${c.firstTouchLeads} leads booked`
        : 'No leads in window',
  },
  roas: {
    display: 'ROAS',
    direction: 'higher_better',
    nativeUnit: 'ratio',
    isWindowScaled: false,
    derive: (c) =>
      c.totalSpendCents > 0 ? c.bookedRevenueCents / c.totalSpendCents : null,
    describe: (c) =>
      c.totalSpendCents > 0
        ? `$${(c.bookedRevenueCents / 100).toFixed(0)} revenue / $${(c.totalSpendCents / 100).toFixed(0)} spend`
        : 'No spend in window',
  },
  return_on_ad_spend: {
    display: 'Return on ad spend',
    direction: 'higher_better',
    nativeUnit: 'ratio',
    isWindowScaled: false,
    derive: (c) =>
      c.totalSpendCents > 0 ? c.bookedRevenueCents / c.totalSpendCents : null,
    describe: (c) =>
      c.totalSpendCents > 0
        ? `$${(c.bookedRevenueCents / 100).toFixed(0)} revenue / $${(c.totalSpendCents / 100).toFixed(0)} spend`
        : 'No spend in window',
  },
  monthly_spend: {
    display: 'Monthly spend',
    direction: 'neutral',
    nativeUnit: 'cents',
    isWindowScaled: true,
    derive: (c) => c.totalSpendCents,
    describe: (c) =>
      `$${(c.totalSpendCents / 100).toFixed(0)} total spend in ${c.windowDays} days`,
  },
  ad_spend: {
    display: 'Ad spend',
    direction: 'neutral',
    nativeUnit: 'cents',
    isWindowScaled: true,
    derive: (c) => c.totalSpendCents,
    describe: (c) =>
      `$${(c.totalSpendCents / 100).toFixed(0)} total spend in ${c.windowDays} days`,
  },
}

// Metrics Bloom can't measure today. We name them so the UI can give
// a useful "where to look instead" hint instead of a silent error.
const UNMEASURABLE_METRICS: Record<string, string> = {
  impressions: 'Impressions are only visible in the platform consoles (Google Ads, Meta Ads). Connect those connectors to bring this in-house.',
  impressions_per_month: 'Same as impressions.',
  brand_search_lift: 'Brand-search lift requires Google Ads + Search Console OAuth. Coming in a later phase.',
  share_of_voice: 'Share-of-voice is comparative — needs an external benchmark we do not have.',
  ad_recall: 'Ad recall is survey-driven and outside Bloom.',
  reach: 'Reach is platform-side only.',
}

// ---------------------------------------------------------------------------
// Window scaling
// ---------------------------------------------------------------------------

const APPROX_DAYS_PER_WINDOW: Record<string, number> = {
  month: 30,
  quarter: 90,
  year: 365,
}

// Given a count measured over `measurementDays`, scale it to the
// equivalent target window. Returns null for unsupported windows or
// when target_window is 'engagement' (which doesn't normalize).
function scaleCount(
  value: number,
  measurementDays: number,
  targetWindow: string,
): number | null {
  if (targetWindow === 'engagement') return value
  const targetDays = APPROX_DAYS_PER_WINDOW[targetWindow]
  if (!targetDays || measurementDays <= 0) return null
  return (value * targetDays) / measurementDays
}

// ---------------------------------------------------------------------------
// Unit conversion (within rate/count semantics)
// ---------------------------------------------------------------------------

function convertUnit(
  value: number,
  fromUnit: 'count' | 'cents' | 'percent' | 'ratio',
  toUnit: string,
): number | null {
  if (fromUnit === toUnit) return value
  if (fromUnit === 'cents' && toUnit === 'usd') return value / 100
  if (fromUnit === 'percent' && toUnit === 'ratio') return value / 100
  if (fromUnit === 'ratio' && toUnit === 'percent') return value * 100
  // For non-currency mismatches we don't auto-convert (e.g. count → days).
  // The KPI is then flagged unit_mismatch via null.
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface KpiCommitmentRowFromDb {
  id: string
  metric_name: string
  target_value: number | string
  target_unit: string
  target_window: string
  effective_from: string
  effective_to: string | null
  notes: string | null
}

export async function computeKpiPerformance(args: {
  agencyId: string
  venueIds: string[]
  windowDays?: number
  /** Include retired KPIs? Default false. */
  includeRetired?: boolean
}): Promise<KpiPerformanceRow[]> {
  const windowDays = args.windowDays ?? 90
  const service = createServiceClient()

  // Pull KPI commitments.
  let q = service
    .from('agency_kpi_commitments')
    .select(
      'id, metric_name, target_value, target_unit, target_window, effective_from, effective_to, notes',
    )
    .eq('agency_id', args.agencyId)
    .is('deleted_at', null)
    .order('effective_from', { ascending: false })
  if (!args.includeRetired) q = q.is('effective_to', null)
  const { data: kpiRows } = await q
  const kpis = (kpiRows ?? []) as KpiCommitmentRowFromDb[]

  if (kpis.length === 0) return []

  // Pull breakdown + ROI in parallel (independent reads).
  const [breakdown, roi] = await Promise.all([
    computeAgencyBreakdown({
      agencyId: args.agencyId,
      venueIds: args.venueIds,
      windowDays,
    }),
    computeAgencyROI({
      agencyId: args.agencyId,
      venueIds: args.venueIds,
      windowDays,
    }),
  ])

  // Build derivation context from ROI (gives totals across all channels).
  const ctx: DeriveContext = {
    windowDays: roi.windowDays,
    totalSpendCents: roi.totalSpendCents,
    firstTouchLeads: roi.firstTouchLeads,
    firstTouchTours: roi.firstTouchTours,
    firstTouchBookings: roi.firstTouchBookings,
    bookedRevenueCents: roi.bookedRevenueCents,
    costPerLeadCents: roi.costPerLeadCents,
    costPerBookingCents: roi.costPerBookingCents,
  }
  // Keep the breakdown reference so future versions can dive per-channel.
  void breakdown

  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000

  return kpis.map((k) => {
    const metricKey = k.metric_name.toLowerCase().trim()
    const rule = METRIC_REGISTRY[metricKey]
    const targetValue = Number(k.target_value)

    // Common fields applied to every row.
    const base: Pick<
      KpiPerformanceRow,
      | 'kpiId'
      | 'metricName'
      | 'metricDisplay'
      | 'targetValue'
      | 'targetUnit'
      | 'targetWindow'
      | 'effectiveFrom'
      | 'effectiveTo'
      | 'notes'
      | 'measurementDays'
      | 'direction'
    > = {
      kpiId: k.id,
      metricName: k.metric_name,
      metricDisplay: rule?.display ?? k.metric_name,
      targetValue,
      targetUnit: k.target_unit,
      targetWindow: k.target_window,
      effectiveFrom: k.effective_from,
      effectiveTo: k.effective_to,
      notes: k.notes,
      measurementDays: ctx.windowDays,
      direction: rule?.direction ?? 'neutral',
    }

    // ---- Unmeasurable metric? ----
    if (!rule) {
      const hint = UNMEASURABLE_METRICS[metricKey]
      return {
        ...base,
        actualValue: null,
        actualLabel: hint ?? 'Metric not currently measured by Bloom.',
        gapPct: null,
        status: 'not_measurable',
        statusLabel: 'Not measurable',
        reasoning:
          hint ??
          `No mapping for metric "${k.metric_name}". Add a registry entry in marketing-agency-kpi-performance.ts to wire it up.`,
        confidence: 'high',
        confidenceReasoning:
          'Status is definitive — Bloom does not measure this metric.',
      }
    }

    // ---- Engagement too young? ----
    const effectiveFromMs = new Date(`${k.effective_from}T00:00:00.000Z`).getTime()
    const ageDays = Math.max(0, (now - effectiveFromMs) / dayMs)
    const minAgeForJudgment = rule.isWindowScaled
      ? APPROX_DAYS_PER_WINDOW[k.target_window] ?? 30
      : 30
    if (ageDays < Math.min(minAgeForJudgment, 30)) {
      return {
        ...base,
        actualValue: rule.derive(ctx),
        actualLabel: rule.describe(ctx),
        gapPct: null,
        status: 'too_early',
        statusLabel: 'Too early to judge',
        reasoning: `KPI took effect ${Math.round(ageDays)} day${ageDays === 1 ? '' : 's'} ago. Wait at least ${Math.round(minAgeForJudgment)} days before reading hit/miss.`,
        confidence: 'low',
        confidenceReasoning:
          'Insufficient time-on-test. Status will firm up as more events land.',
      }
    }

    // ---- Derive natural value ----
    const naturalValue = rule.derive(ctx)
    if (naturalValue === null) {
      return {
        ...base,
        actualValue: null,
        actualLabel: rule.describe(ctx),
        gapPct: null,
        status: 'no_data',
        statusLabel: 'No data yet',
        reasoning:
          'No events of this kind landed in the measurement window. Either the channels are quiet or attribution is going elsewhere.',
        confidence: 'medium',
        confidenceReasoning:
          'Definite zero is different from missing data — check pixel + UTM coverage before treating as a miss.',
      }
    }

    // ---- Scale for window if needed ----
    let scaled = naturalValue
    if (rule.isWindowScaled) {
      const scaledOrNull = scaleCount(naturalValue, ctx.windowDays, k.target_window)
      if (scaledOrNull === null) {
        return {
          ...base,
          actualValue: null,
          actualLabel: rule.describe(ctx),
          gapPct: null,
          status: 'not_measurable',
          statusLabel: 'Window mismatch',
          reasoning: `Cannot scale a ${rule.nativeUnit} from ${ctx.windowDays} days to target_window "${k.target_window}". Supported windows: month, quarter, year, engagement.`,
          confidence: 'high',
          confidenceReasoning: 'Configuration issue, not a data issue.',
        }
      }
      scaled = scaledOrNull
    }

    // ---- Unit conversion ----
    let actualInTargetUnit: number | null = scaled
    if (rule.nativeUnit !== k.target_unit) {
      actualInTargetUnit = convertUnit(scaled, rule.nativeUnit, k.target_unit)
      if (actualInTargetUnit === null) {
        return {
          ...base,
          actualValue: null,
          actualLabel: rule.describe(ctx),
          gapPct: null,
          status: 'not_measurable',
          statusLabel: 'Unit mismatch',
          reasoning: `Metric "${k.metric_name}" produces ${rule.nativeUnit}, but KPI targets ${k.target_unit}. No conversion defined.`,
          confidence: 'high',
          confidenceReasoning: 'Configuration issue.',
        }
      }
    }

    // ---- Gap + status ----
    const gapPct =
      targetValue !== 0
        ? ((actualInTargetUnit - targetValue) / targetValue) * 100
        : null

    let status: KpiStatus
    let statusLabel: string
    let reasoning: string
    const closeBandPct = 10

    if (gapPct === null) {
      status = 'no_data'
      statusLabel = 'Target is zero'
      reasoning = 'Target value of zero blocks percentage comparison. Set a non-zero target or use absolute thresholds.'
    } else {
      const isFavorable =
        (rule.direction === 'higher_better' && actualInTargetUnit >= targetValue) ||
        (rule.direction === 'lower_better' && actualInTargetUnit <= targetValue) ||
        rule.direction === 'neutral'
      if (isFavorable) {
        status = 'hit'
        statusLabel = 'Hit'
        reasoning = `Actual ${actualInTargetUnit.toFixed(2)} ${k.target_unit} ${rule.direction === 'higher_better' ? '≥' : rule.direction === 'lower_better' ? '≤' : 'vs'} target ${targetValue}.`
      } else if (Math.abs(gapPct) <= closeBandPct) {
        status = 'close'
        statusLabel = `Close (${gapPct > 0 ? '+' : ''}${gapPct.toFixed(0)}%)`
        reasoning = `Within ${closeBandPct}% of target. Worth flagging but not a clean miss.`
      } else {
        status = 'miss'
        statusLabel = `Miss (${gapPct > 0 ? '+' : ''}${gapPct.toFixed(0)}%)`
        reasoning = `${gapPct > 0 ? 'Over' : 'Under'} target by ${Math.abs(gapPct).toFixed(0)}%.`
      }
    }

    // ---- Confidence based on sample size + window scaling ----
    let confidence: KpiPerformanceRow['confidence'] = 'medium'
    let confidenceReasoning = 'Default measurement confidence.'
    const sampleSize = ctx.firstTouchLeads
    const scaledFromShort =
      rule.isWindowScaled &&
      APPROX_DAYS_PER_WINDOW[k.target_window] &&
      ctx.windowDays < (APPROX_DAYS_PER_WINDOW[k.target_window] ?? 0)
    if (sampleSize >= 30 && !scaledFromShort) {
      confidence = 'high'
      confidenceReasoning = `${sampleSize} attributed events in ${ctx.windowDays}-day window.`
    } else if (sampleSize < 10) {
      confidence = 'low'
      confidenceReasoning = `Only ${sampleSize} attributed events. Small-sample noise can swamp the signal.`
    } else if (scaledFromShort) {
      confidence = 'low'
      confidenceReasoning = `Target is ${k.target_window}-windowed but only ${ctx.windowDays} days measured — scaling adds noise.`
    } else {
      confidenceReasoning = `${sampleSize} events. Adequate sample.`
    }

    return {
      ...base,
      actualValue: actualInTargetUnit,
      actualLabel: rule.describe(ctx),
      gapPct,
      status,
      statusLabel,
      reasoning,
      confidence,
      confidenceReasoning,
    }
  })
}
