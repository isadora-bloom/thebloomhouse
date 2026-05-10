/**
 * Bloom House — Wave 7C test executor.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7C closes the discovery loop —
 *     Wave 7A produces hypotheses, Wave 7C executes their tests.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7C spec — executor handles
 *     cohort comparison + time shift + channel comparison patterns.)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose — the
 *     executor returns numeric aggregates only; never per-couple PII.)
 *
 * What this module does
 * ---------------------
 * Given a structured test plan from the Sonnet test designer, run it
 * against the venue's data and return numeric aggregates suitable for
 * the Sonnet result interpreter to label.
 *
 * Recognised filter shapes
 * ------------------------
 *   - { source_platform: <string> } → attribution_events.source_platform
 *   - { source_platform: 'theknot', has_prior_engagement: true } →
 *       wedding has Knot row PLUS at least one earlier non-Knot row
 *   - { source_platform: 'theknot', has_prior_engagement: false } →
 *       wedding has Knot row but no earlier non-Knot row
 *   - { persona_label: <string> } → couple_intel.persona_label
 *   - { role: 'acquisition' | 'validation' | 'conversion' } →
 *       attribution_events.role
 *   - { time_window: { start_iso, end_iso } } → wedding.inquiry_date
 *   - Combinations are AND-ed across filter keys.
 *
 * Recognised metrics
 * ------------------
 *   - 'conversion_rate' (n_booked / n_inquiries × 100)
 *   - 'median_close_probability' (median couple_intel.predicted_close_probability_pct)
 *   - 'days_to_book' (mean days from inquiry_date to booked_at)
 *   - 'attribution_count' (count of attribution_events matching filter)
 *   - 'inquiry_volume' (count of weddings matching filter)
 *
 * Recognised statistical tests
 * ----------------------------
 *   - 'two_proportion_z' (binomial — for conversion_rate)
 *   - 'welch_t_approx' (unequal-variance t — for medians/means; we use
 *     a coarse approximation since we do not pull a stats library)
 *   - 'simple_lift' (no significance, lift % only — fallback)
 *
 * LIMITATIONS
 * -----------
 * Wave 7C deliberately does NOT pull a stats library (no new npm deps).
 * The p-value approximations are coarse:
 *   - two_proportion_z uses the standard z-statistic but converts to
 *     a one-sided p via a 6-term polynomial approximation of the
 *     standard-normal CDF (Abramowitz & Stegun 26.2.17). Accurate to
 *     ~7e-8 in the bulk; less reliable beyond |z|=4.
 *   - welch_t_approx returns the t-statistic and a coarse p-value
 *     estimate (treats t as approximately normal for n >= 30; degrades
 *     toward 'unknown' for smaller n). The Sonnet interpreter is told
 *     in its prompt to weight p-value loosely; this is intentional.
 *   - simple_lift returns p_value_approx=null.
 *
 * A future iteration may import a small stats package — but the
 * current shape is sufficient for the Wave 7C MVP and avoids dependency
 * churn at parallel-stream merge time.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { HypothesisTestPlan } from '@/config/prompts/hypothesis-validator'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecuteValidationTestInput {
  testPlan: HypothesisTestPlan
  venueId: string
  supabase: SupabaseClient
  /** Trailing window for wedding/attribution scan. Default 365. */
  windowDays?: number
}

export interface TestExecutionResult {
  metric_value_treatment: number | null
  metric_value_control: number | null
  /** Lift expressed as percent change of treatment vs control. */
  lift_pct: number | null
  n_treatment: number
  n_control: number
  p_value_approx: number | null
  statistical_test_used: string
  errors: string[]
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 365
const DAY_MS = 86_400_000
const MAX_ATTR_LOAD = 5000
const MAX_WEDDING_LOAD = 5000
const MAX_INTEL_LOAD = 5000

// ---------------------------------------------------------------------------
// Loaders — anonymised aggregate scans only.
// ---------------------------------------------------------------------------

interface AttributionRow {
  id: string
  wedding_id: string
  source_platform: string
  role: string | null
  decided_at: string
  reverted_at: string | null
}

interface WeddingRow {
  id: string
  status: string | null
  inquiry_date: string | null
  booked_at: string | null
}

interface CoupleIntelRow {
  wedding_id: string
  persona_label: string | null
  predicted_close_probability_pct: number | null
}

interface CohortContext {
  attributions: AttributionRow[]
  weddings: Map<string, WeddingRow>
  coupleIntelByWedding: Map<string, CoupleIntelRow>
  attributionsByWedding: Map<string, AttributionRow[]>
}

async function loadCohortContext(
  supabase: SupabaseClient,
  venueId: string,
  windowDays: number,
): Promise<{ context: CohortContext; errors: string[] }> {
  const errors: string[] = []
  const windowStartIso = new Date(
    Date.now() - windowDays * DAY_MS,
  ).toISOString()

  const [attrRes, weddingRes, intelRes] = await Promise.all([
    supabase
      .from('attribution_events')
      .select('id, wedding_id, source_platform, role, decided_at, reverted_at')
      .eq('venue_id', venueId)
      .is('reverted_at', null)
      .gte('decided_at', windowStartIso)
      .limit(MAX_ATTR_LOAD),
    supabase
      .from('weddings')
      .select('id, status, inquiry_date, booked_at')
      .eq('venue_id', venueId)
      .gte('inquiry_date', windowStartIso)
      .limit(MAX_WEDDING_LOAD),
    supabase
      .from('couple_intel')
      .select('wedding_id, persona_label, predicted_close_probability_pct')
      .eq('venue_id', venueId)
      .limit(MAX_INTEL_LOAD),
  ])

  if (attrRes.error) {
    errors.push(`attribution_events: ${attrRes.error.message}`)
  }
  if (weddingRes.error) {
    errors.push(`weddings: ${weddingRes.error.message}`)
  }
  if (intelRes.error) {
    errors.push(`couple_intel: ${intelRes.error.message}`)
  }

  const attributions = (attrRes.data ?? []) as AttributionRow[]
  const weddingsList = (weddingRes.data ?? []) as WeddingRow[]
  const intelList = (intelRes.data ?? []) as CoupleIntelRow[]

  const weddings = new Map<string, WeddingRow>()
  for (const w of weddingsList) weddings.set(w.id, w)

  const coupleIntelByWedding = new Map<string, CoupleIntelRow>()
  for (const r of intelList) coupleIntelByWedding.set(r.wedding_id, r)

  const attributionsByWedding = new Map<string, AttributionRow[]>()
  for (const a of attributions) {
    const arr = attributionsByWedding.get(a.wedding_id) ?? []
    arr.push(a)
    attributionsByWedding.set(a.wedding_id, arr)
  }
  // Sort each wedding's attributions oldest-first so has_prior_engagement
  // can be checked by walking the chain.
  for (const arr of attributionsByWedding.values()) {
    arr.sort(
      (a, b) =>
        Date.parse(a.decided_at || '0') - Date.parse(b.decided_at || '0'),
    )
  }

  return {
    context: { attributions, weddings, coupleIntelByWedding, attributionsByWedding },
    errors,
  }
}

// ---------------------------------------------------------------------------
// Filter resolution — produce the wedding-id set matching a filter object.
// ---------------------------------------------------------------------------

interface ResolveFilterResult {
  weddingIds: Set<string>
  errors: string[]
  unknownKeys: string[]
}

function normalisePlatform(raw: string): string {
  const lower = (raw || '').trim().toLowerCase()
  if (lower === 'theknot' || lower === 'the_knot' || lower === 'knot') {
    return 'theknot'
  }
  if (lower === 'instagram' || lower === 'facebook' || lower === 'meta') {
    return 'meta'
  }
  if (lower === 'tiktok') return 'tiktok'
  if (lower === 'google' || lower === 'google_search') return 'google'
  if (lower === 'weddingwire') return 'weddingwire'
  return lower
}

function resolveFilter(
  filter: Record<string, unknown>,
  ctx: CohortContext,
): ResolveFilterResult {
  const errors: string[] = []
  const unknownKeys: string[] = []

  // Start from the universe of weddings. We then intersect with each
  // recognised filter key.
  let candidate: Set<string> = new Set(ctx.weddings.keys())

  // Check unknown keys up-front so the executor can flag the test as
  // unrunnable rather than silently ignoring the filter.
  const RECOGNISED_KEYS = new Set([
    'source_platform',
    'has_prior_engagement',
    'persona_label',
    'role',
    'time_window',
  ])
  for (const key of Object.keys(filter)) {
    if (!RECOGNISED_KEYS.has(key)) unknownKeys.push(key)
  }

  // source_platform — wedding has at least one matching attribution_event
  // (with optional role / has_prior_engagement layered in below).
  if (typeof filter['source_platform'] === 'string') {
    const target = normalisePlatform(filter['source_platform'] as string)
    const targetWeddings = new Set<string>()
    for (const a of ctx.attributions) {
      if (normalisePlatform(a.source_platform) === target) {
        targetWeddings.add(a.wedding_id)
      }
    }
    candidate = intersect(candidate, targetWeddings)

    // has_prior_engagement only meaningful when source_platform is set.
    // true → at least one attribution PRIOR to the earliest target-platform
    //        attribution that is on a DIFFERENT platform.
    // false → no such prior cross-platform attribution.
    const hpe = filter['has_prior_engagement']
    if (hpe === true || hpe === false) {
      const result = new Set<string>()
      for (const wid of candidate) {
        const arr = ctx.attributionsByWedding.get(wid) ?? []
        // Earliest target-platform attribution time.
        let earliestTargetT = Number.POSITIVE_INFINITY
        for (const a of arr) {
          if (normalisePlatform(a.source_platform) !== target) continue
          const t = Date.parse(a.decided_at || '0')
          if (Number.isFinite(t) && t < earliestTargetT) earliestTargetT = t
        }
        let hasPrior = false
        for (const a of arr) {
          if (normalisePlatform(a.source_platform) === target) continue
          const t = Date.parse(a.decided_at || '0')
          if (Number.isFinite(t) && t < earliestTargetT) {
            hasPrior = true
            break
          }
        }
        if (hpe === true && hasPrior) result.add(wid)
        if (hpe === false && !hasPrior) result.add(wid)
      }
      candidate = result
    }
  }

  // persona_label — couple_intel match.
  if (typeof filter['persona_label'] === 'string') {
    const target = (filter['persona_label'] as string).trim().toLowerCase()
    const personaWeddings = new Set<string>()
    for (const [wid, intel] of ctx.coupleIntelByWedding.entries()) {
      const lbl = (intel.persona_label || '').trim().toLowerCase()
      if (lbl === target) personaWeddings.add(wid)
    }
    candidate = intersect(candidate, personaWeddings)
  }

  // role — wedding has at least one attribution with that role.
  // Recognises 'acquisition' | 'validation' | 'conversion' | 'unknown'.
  if (typeof filter['role'] === 'string') {
    const target = (filter['role'] as string).trim().toLowerCase()
    const roleWeddings = new Set<string>()
    for (const a of ctx.attributions) {
      if ((a.role || 'unknown').toLowerCase() === target) {
        roleWeddings.add(a.wedding_id)
      }
    }
    candidate = intersect(candidate, roleWeddings)
  }

  // time_window — wedding.inquiry_date in [start, end].
  const tw = filter['time_window']
  if (tw && typeof tw === 'object' && !Array.isArray(tw)) {
    const twObj = tw as Record<string, unknown>
    const startIso =
      typeof twObj['start_iso'] === 'string' ? (twObj['start_iso'] as string) : null
    const endIso =
      typeof twObj['end_iso'] === 'string' ? (twObj['end_iso'] as string) : null
    if (!startIso && !endIso) {
      errors.push('time_window present but neither start_iso nor end_iso parseable')
    } else {
      const startT = startIso ? Date.parse(startIso) : Number.NEGATIVE_INFINITY
      const endT = endIso ? Date.parse(endIso) : Number.POSITIVE_INFINITY
      const windowed = new Set<string>()
      for (const [wid, w] of ctx.weddings.entries()) {
        if (!w.inquiry_date) continue
        const t = Date.parse(w.inquiry_date)
        if (!Number.isFinite(t)) continue
        if (t >= startT && t <= endT) windowed.add(wid)
      }
      candidate = intersect(candidate, windowed)
    }
  }

  return { weddingIds: candidate, errors, unknownKeys }
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>()
  for (const x of a) if (b.has(x)) out.add(x)
  return out
}

// ---------------------------------------------------------------------------
// Metric computation per cohort
// ---------------------------------------------------------------------------

interface MetricSnapshot {
  metric_value: number | null
  /**
   * For variance-aware tests we also need the sample data (or a small
   * proxy). For conversion_rate we hold n_success + n_total. For
   * median/mean we hold the sample array.
   */
  successCount?: number
  totalCount?: number
  sample?: number[]
}

function computeMetric(
  metric: string,
  weddingIds: Set<string>,
  ctx: CohortContext,
): MetricSnapshot | null {
  const idsArr = Array.from(weddingIds)
  if (metric === 'conversion_rate') {
    let booked = 0
    let total = 0
    for (const wid of idsArr) {
      const w = ctx.weddings.get(wid)
      if (!w) continue
      total += 1
      const status = (w.status || '').toLowerCase()
      if (status === 'booked' || status === 'completed' || w.booked_at) {
        booked += 1
      }
    }
    if (total === 0) {
      return { metric_value: null, successCount: 0, totalCount: 0 }
    }
    return {
      metric_value: Math.round((booked / total) * 1000) / 10, // %
      successCount: booked,
      totalCount: total,
    }
  }
  if (metric === 'median_close_probability') {
    const sample: number[] = []
    for (const wid of idsArr) {
      const intel = ctx.coupleIntelByWedding.get(wid)
      const v = intel?.predicted_close_probability_pct
      if (typeof v === 'number' && Number.isFinite(v)) sample.push(v)
    }
    if (sample.length === 0) return { metric_value: null, sample: [] }
    return { metric_value: median(sample), sample }
  }
  if (metric === 'days_to_book') {
    const sample: number[] = []
    for (const wid of idsArr) {
      const w = ctx.weddings.get(wid)
      if (!w?.inquiry_date || !w?.booked_at) continue
      const inq = Date.parse(w.inquiry_date)
      const book = Date.parse(w.booked_at)
      if (!Number.isFinite(inq) || !Number.isFinite(book)) continue
      const days = (book - inq) / DAY_MS
      if (days < 0 || days > 365 * 3) continue // sanity bound
      sample.push(days)
    }
    if (sample.length === 0) return { metric_value: null, sample: [] }
    return { metric_value: mean(sample), sample }
  }
  if (metric === 'attribution_count') {
    let count = 0
    for (const a of ctx.attributions) {
      if (weddingIds.has(a.wedding_id)) count += 1
    }
    return {
      metric_value: count,
      totalCount: count,
    }
  }
  if (metric === 'inquiry_volume') {
    return {
      metric_value: weddingIds.size,
      totalCount: weddingIds.size,
    }
  }
  return null
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let sum = 0
  for (const x of xs) sum += x
  return sum / xs.length
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = xs.slice().sort((a, b) => a - b)
  const n = sorted.length
  return n % 2 === 1
    ? sorted[Math.floor(n / 2)]
    : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let s = 0
  for (const x of xs) s += (x - m) * (x - m)
  return s / (xs.length - 1)
}

// ---------------------------------------------------------------------------
// Statistical tests — coarse approximations (no stats library).
// ---------------------------------------------------------------------------

/**
 * Standard normal CDF approximation (Abramowitz & Stegun 26.2.17).
 * Accuracy ~7.5e-8 in the bulk; degrades beyond |z|=4.
 */
function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return 0.5
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  // Constants for the rational approximation of erf
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * x)
  const y =
    1 -
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  // erf(x) ~= y; standard normal CDF = 0.5 * (1 + erf(z/sqrt(2)))
  return 0.5 * (1 + sign * y)
}

/**
 * Two-proportion z test (one-sided p-value approximation). Returns null
 * if any cohort is empty or the pooled proportion is degenerate.
 */
function twoProportionZ(
  s1: number,
  n1: number,
  s2: number,
  n2: number,
): { z: number; p_one_sided: number } | null {
  if (n1 <= 0 || n2 <= 0) return null
  const p1 = s1 / n1
  const p2 = s2 / n2
  const pooled = (s1 + s2) / (n1 + n2)
  const denom = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (!Number.isFinite(denom) || denom === 0) return null
  const z = (p1 - p2) / denom
  // One-sided p-value: probability of observing a difference this large
  // OR larger in the same direction.
  const p_one_sided = z >= 0 ? 1 - normalCdf(z) : normalCdf(z)
  return { z, p_one_sided }
}

/**
 * Welch's t-statistic (unequal-variance). Returns the t and a coarse
 * p-value: for n_eff >= 30 we treat t as standard normal; otherwise
 * we return null and let the interpreter weight on lift + n.
 */
function welchT(
  m1: number,
  v1: number,
  n1: number,
  m2: number,
  v2: number,
  n2: number,
): { t: number; p_one_sided: number | null } | null {
  if (n1 < 2 || n2 < 2) return null
  const denom = Math.sqrt(v1 / n1 + v2 / n2)
  if (!Number.isFinite(denom) || denom === 0) return null
  const t = (m1 - m2) / denom
  const nEff = Math.min(n1, n2)
  if (nEff >= 30) {
    const p = t >= 0 ? 1 - normalCdf(t) : normalCdf(t)
    return { t, p_one_sided: p }
  }
  return { t, p_one_sided: null }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function executeValidationTest(
  input: ExecuteValidationTestInput,
): Promise<TestExecutionResult> {
  const { testPlan, venueId, supabase } = input
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS
  const errors: string[] = []

  if (!venueId) {
    return emptyResult([
      'venueId required',
    ])
  }

  // Custom test_kind is intentionally not executed — Sonnet designer
  // returns 'custom' when it cannot map the hypothesis to a recognised
  // shape. The interpreter will see errors=['unsupported test_kind:custom']
  // and label data_too_thin per its prompt rules.
  if (testPlan.test_kind === 'custom') {
    return emptyResult(['unsupported test_kind: custom'])
  }

  const { context, errors: loadErrors } = await loadCohortContext(
    supabase,
    venueId,
    windowDays,
  )
  errors.push(...loadErrors)

  const treatment = resolveFilter(testPlan.treatment_cohort_filter, context)
  const control = resolveFilter(testPlan.control_cohort_filter, context)
  errors.push(...treatment.errors.map((e) => `treatment: ${e}`))
  errors.push(...control.errors.map((e) => `control: ${e}`))
  if (treatment.unknownKeys.length > 0) {
    errors.push(
      `treatment: unrecognised filter keys: ${treatment.unknownKeys.join(',')}`,
    )
  }
  if (control.unknownKeys.length > 0) {
    errors.push(
      `control: unrecognised filter keys: ${control.unknownKeys.join(',')}`,
    )
  }

  const treatmentMetric = computeMetric(testPlan.metric, treatment.weddingIds, context)
  const controlMetric = computeMetric(testPlan.metric, control.weddingIds, context)

  if (treatmentMetric === null || controlMetric === null) {
    errors.push(`unsupported metric: ${testPlan.metric}`)
    return {
      metric_value_treatment: null,
      metric_value_control: null,
      lift_pct: null,
      n_treatment: treatment.weddingIds.size,
      n_control: control.weddingIds.size,
      p_value_approx: null,
      statistical_test_used: testPlan.statistical_test,
      errors,
    }
  }

  // n's reported as the cohort SIZE (weddings) for cohort-style metrics
  // and as the SAMPLE size for distribution metrics. The interpreter is
  // told to read n as "rows backing the metric", so for
  // median_close_probability we want the count of non-null sample values.
  const nTreatment = nForMetric(testPlan.metric, treatmentMetric, treatment.weddingIds.size)
  const nControl = nForMetric(testPlan.metric, controlMetric, control.weddingIds.size)

  // Lift_pct: compute relative to the control's metric value.
  let liftPct: number | null = null
  if (
    treatmentMetric.metric_value !== null &&
    controlMetric.metric_value !== null &&
    Math.abs(controlMetric.metric_value) > 0
  ) {
    liftPct =
      ((treatmentMetric.metric_value - controlMetric.metric_value) /
        Math.abs(controlMetric.metric_value)) *
      100
    liftPct = Math.round(liftPct * 100) / 100
  } else if (
    treatmentMetric.metric_value !== null &&
    controlMetric.metric_value !== null &&
    controlMetric.metric_value === 0
  ) {
    // Avoid Inf% — flag as null with an explanatory error.
    if (treatmentMetric.metric_value !== 0) {
      errors.push('control metric is 0; lift_pct not computable')
    } else {
      liftPct = 0
    }
  }

  // Statistical test selection.
  let pValueApprox: number | null = null
  let statisticalTestUsed = testPlan.statistical_test
  if (testPlan.statistical_test === 'two_proportion_z') {
    if (testPlan.metric !== 'conversion_rate') {
      errors.push(
        `two_proportion_z requires conversion_rate metric (got ${testPlan.metric})`,
      )
    } else {
      const z = twoProportionZ(
        treatmentMetric.successCount ?? 0,
        treatmentMetric.totalCount ?? 0,
        controlMetric.successCount ?? 0,
        controlMetric.totalCount ?? 0,
      )
      if (z) pValueApprox = round4(z.p_one_sided)
      else errors.push('two_proportion_z: degenerate sample (cohort empty)')
    }
  } else if (testPlan.statistical_test === 'welch_t_approx') {
    const tSample = treatmentMetric.sample ?? []
    const cSample = controlMetric.sample ?? []
    if (tSample.length < 2 || cSample.length < 2) {
      errors.push(
        `welch_t_approx: each cohort needs n >= 2 (treatment=${tSample.length}, control=${cSample.length})`,
      )
    } else {
      const r = welchT(
        mean(tSample),
        variance(tSample),
        tSample.length,
        mean(cSample),
        variance(cSample),
        cSample.length,
      )
      if (r) {
        pValueApprox = r.p_one_sided !== null ? round4(r.p_one_sided) : null
      } else {
        errors.push('welch_t_approx: degenerate (zero variance or n < 2)')
      }
    }
  } else if (testPlan.statistical_test === 'simple_lift') {
    pValueApprox = null // documented behaviour
  } else {
    errors.push(`unsupported statistical_test: ${testPlan.statistical_test}`)
    statisticalTestUsed = 'unknown'
  }

  return {
    metric_value_treatment: roundMetric(treatmentMetric.metric_value),
    metric_value_control: roundMetric(controlMetric.metric_value),
    lift_pct: liftPct,
    n_treatment: nTreatment,
    n_control: nControl,
    p_value_approx: pValueApprox,
    statistical_test_used: statisticalTestUsed,
    errors,
  }
}

function nForMetric(metric: string, snap: MetricSnapshot, fallback: number): number {
  if (metric === 'conversion_rate') {
    return snap.totalCount ?? fallback
  }
  if (metric === 'median_close_probability' || metric === 'days_to_book') {
    return snap.sample?.length ?? fallback
  }
  return snap.totalCount ?? fallback
}

function roundMetric(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10_000) / 10_000
}

function emptyResult(errors: string[]): TestExecutionResult {
  return {
    metric_value_treatment: null,
    metric_value_control: null,
    lift_pct: null,
    n_treatment: 0,
    n_control: 0,
    p_value_approx: null,
    statistical_test_used: 'unknown',
    errors,
  }
}
