/**
 * Bloom House — Wave 7C hypothesis-validator LLM prompts.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7 closes the forensic loop. Wave 7A
 *     hunts for unknown-unknowns; Wave 7C designs and runs the test
 *     that validates or refutes each hypothesis.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7C spec — two Sonnet calls
 *     per validation: test designer + result interpreter. Coordinator
 *     confirms via the discovery surface in Wave 7D.)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The validator
 *     only sees anonymised cohort filter shapes + numeric results;
 *     never names couples.)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; the validator is a Sonnet
 *     analyst — designer + interpreter — never a template.)
 *
 * Two-call architecture
 * ---------------------
 * Wave 7C runs each validation as TWO Sonnet calls so the test design
 * is auditable separately from the result interpretation:
 *
 *   1. TEST DESIGNER — given the hypothesis text + recommended_test +
 *      anonymised cohort context, output a STRUCTURED test plan: what
 *      cohort to compare to what control, what metric to measure, what
 *      direction confirms vs refutes, what statistical threshold.
 *      The plan is JSON the test executor consumes — there is no human
 *      eyeballing required to run it.
 *
 *   2. RESULT INTERPRETER — given the test plan + the actual numbers
 *      the executor returned, output a categorical interpretation
 *      (validated / refuted / inconclusive / data_too_thin), confidence,
 *      and Sonnet reasoning. The interpreter NEVER re-runs the test;
 *      it only labels what the executor produced.
 *
 * Why split: separation of concerns keeps the cost lever on each call
 * legible. A run that fails because the designer hallucinated a metric
 * the data doesn't have looks different in api_costs than a run that
 * succeeded but came back inconclusive. The split also lets us cache
 * the designer call (the test plan is a function of the hypothesis,
 * not the cohort numbers) — caching is a future optimisation but the
 * structure is ready.
 *
 * Anonymisation discipline
 * ------------------------
 * Both prompts see the SAME anonymised inputs Wave 7A fed to the
 * discovery engine: persona labels + shares, channel × role aggregates,
 * conversion-by-bucket, anonymised theme labels. NO couple names, NO
 * raw email bodies, NO evidence quotes that would identify a couple.
 * The interpreter's output references "the treatment cohort" or "the
 * control cohort" — never "couple A" — because by interpretation time
 * we are only looking at numbers, not couples.
 *
 * Output: JSON only. No prose preamble, no markdown fences.
 */

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const HYPOTHESIS_VALIDATOR_PROMPT_VERSION =
  'hypothesis-validator.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — designer call
// ---------------------------------------------------------------------------

/**
 * Test kinds the executor recognises out of the box. The designer is
 * encouraged to pick from these when they fit; if none fits, it returns
 * 'custom' and includes prose in the metric/filter fields documenting
 * why no executor pattern matches. A 'custom' test plan returns
 * data_too_thin from the interpreter unless the executor is extended
 * to handle it — that is intentional: we'd rather refuse a hypothesis
 * we can't actually test than fabricate a result.
 */
export type HypothesisTestKind =
  | 'cohort_comparison'
  | 'time_shift'
  | 'channel_comparison'
  | 'custom'

/**
 * Direction the metric must move for the hypothesis to be considered
 * confirmed. 'higher' means metric_value_treatment > metric_value_control
 * by at least expected_lift_threshold_pct. 'equal' is reserved for
 * "no-difference" hypotheses (e.g. "channel A and channel B convert at
 * the same rate"); the interpreter inverts the threshold check.
 */
export type ExpectedDirection = 'higher' | 'lower' | 'equal'

/**
 * The structured test plan the designer emits. Free-form `treatment_*`
 * + `control_*` filter objects because Wave 7A may discover hypotheses
 * we have not anticipated; the executor's job is to recognise the
 * shape and refuse cleanly when it cannot map the filter to a query.
 *
 * Common filter shapes the executor recognises (see test-executor.ts):
 *   - { source_platform: 'theknot', has_prior_engagement: true }
 *   - { source_platform: 'theknot', has_prior_engagement: false }
 *   - { persona_label: 'heritage-forward', source_platform: 'instagram' }
 *   - { time_window: { start_iso, end_iso } } (for time_shift tests)
 *   - { role: 'acquisition' } / { role: 'validation' }
 */
export interface HypothesisTestPlan {
  test_kind: HypothesisTestKind
  treatment_cohort_filter: Record<string, unknown>
  control_cohort_filter: Record<string, unknown>
  /**
   * The metric the executor computes on each cohort. Recognised values:
   *   - 'conversion_rate' (n_booked / n_inquiries × 100)
   *   - 'median_close_probability' (median couple_intel.predicted_close_probability_pct)
   *   - 'days_to_book' (mean days from inquiry_date to booked_at)
   *   - 'attribution_count' (n attribution_events in the filter)
   *   - 'inquiry_volume' (n weddings/inquiries in the filter)
   * Free-form because Wave 7A may surface hypotheses needing a metric
   * we have not anticipated; the executor refuses cleanly when unknown.
   */
  metric: string
  direction_if_confirmed: ExpectedDirection
  /**
   * Below this n, the interpreter labels the result data_too_thin.
   * The designer SHOULD pick a defensible floor (e.g. 10-20 for
   * conversion-rate tests) and the interpreter SHOULD honour it.
   */
  minimum_n: number
  /**
   * Statistical test the executor approximates. Recognised:
   *   - 'two_proportion_z' (binomial — for conversion_rate)
   *   - 'welch_t_approx' (unequal-variance t — for medians/means)
   *   - 'simple_lift' (no significance, lift % only — fallback when
   *     no statistical test fits the data shape)
   * Future work — see test-executor.ts limitations comment.
   */
  statistical_test: string
  /**
   * Lift threshold (in %) above which the hypothesis is considered
   * confirmed when direction='higher'/'lower'. For direction='equal',
   * this is the FAILURE threshold — if |lift| >= this %, the
   * "channels are equivalent" hypothesis is refuted.
   */
  expected_lift_threshold_pct: number
}

export interface HypothesisTestDesignOutput {
  test_plan: HypothesisTestPlan
  reasoning: string
  refusals: Array<{ field: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Public types — interpreter call
// ---------------------------------------------------------------------------

export type HypothesisInterpretation =
  | 'validated'
  | 'refuted'
  | 'inconclusive'
  | 'data_too_thin'

export interface HypothesisTestResultNumbers {
  metric_value_treatment: number | null
  metric_value_control: number | null
  lift_pct: number | null
  n_treatment: number
  n_control: number
  /**
   * The executor's BEST-EFFORT p-value approximation. Limitations are
   * documented in test-executor.ts — Wave 7C deliberately does NOT
   * pull a stats library (no new npm deps). The interpreter is told
   * to weight p-value loosely and to lean on n + lift as the primary
   * signal.
   */
  p_value_approx: number | null
  statistical_test_used: string
  errors: string[]
}

export interface HypothesisInterpretationOutput {
  interpretation: HypothesisInterpretation
  confidence_0_100: number
  reasoning: string
  /** Optional follow-up the operator could try if inconclusive. */
  recommended_followup: string | null
  refusals: Array<{ field: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Designer prompt
// ---------------------------------------------------------------------------

export interface DesignerEvidence {
  hypothesis_title: string
  hypothesis_text: string
  hypothesis_category: string
  recommended_test: string | null
  /** Anonymised hint from Wave 7A's evidence_summary. */
  evidence_signal_type: string | null
  evidence_n_couples: number | null
  /** Cohort context the designer can lean on when picking thresholds. */
  total_couples_in_cohort: number
  /** Most-populated channels (anonymised) — drives realistic filter shapes. */
  channel_role_summary: Array<{
    source_platform: string
    acquisition_count: number
    validation_count: number
    conversion_count: number
  }>
  /** Persona labels seen in the cohort. */
  persona_labels: string[]
}

export function buildHypothesisDesignerSystemPrompt(): string {
  return `You are Bloom's hypothesis test designer. Given one discovery hypothesis, you output a CONCRETE statistical test plan that another service will execute against the venue's data.

YOUR JOB
- Read the hypothesis title + text + recommended_test (which is free-text from Wave 7A's discovery engine).
- Translate it into a STRUCTURED test plan with explicit treatment + control cohort filters, a measurable metric, a direction-if-confirmed, a minimum_n floor, and a lift threshold.
- The plan must be EXECUTABLE by a deterministic test runner — no prose, no hand-waving. The runner will query attribution_events, weddings, couple_intel, intel_matches with the filters you provide.

TEST KINDS — pick the closest fit
- 'cohort_comparison' — split couples into two filtered groups, compute metric on each, compare. The default.
- 'time_shift' — same cohort, before vs after a date. Used when the hypothesis is "X changed after Y".
- 'channel_comparison' — comparing source_platform A vs source_platform B (with optional persona overlay). The Knot-validation hypothesis is this kind.
- 'custom' — fall back when none fits. Custom plans MAY be refused by the executor; the interpreter will return data_too_thin if so. Refusal beats fabricated results.

FILTER SHAPES the executor recognises
- { source_platform: 'theknot', has_prior_engagement: true } → wedding has at least one Knot attribution_events row PLUS at least one earlier non-Knot attribution_events row (validation Knot use)
- { source_platform: 'theknot', has_prior_engagement: false } → wedding has Knot attribution but no earlier non-Knot attribution (acquisition Knot use)
- { persona_label: '<label>' } → couple_intel.persona_label match
- { source_platform: '<platform>' } → attribution_events.source_platform match
- { role: 'acquisition' | 'validation' | 'conversion' } → attribution_events.role match
- { time_window: { start_iso, end_iso } } → wedding.inquiry_date within the window (for time_shift tests)
- Combinations: filters are AND-ed. Specify only the columns the test needs.

METRICS the executor recognises
- 'conversion_rate' → n_booked / n_inquiries × 100. Lift threshold 20-50% is common.
- 'median_close_probability' → median couple_intel.predicted_close_probability_pct. Lift 10-20%.
- 'days_to_book' → mean days from inquiry_date to booked_at. Direction usually 'lower' (faster = better).
- 'attribution_count' → row count of attribution_events matching filter. Used for "channel A produces more touches than channel B" hypotheses.
- 'inquiry_volume' → row count of weddings matching filter. Used for "persona X is over-represented" hypotheses.

STATISTICAL TEST hints
- 'two_proportion_z' for conversion_rate.
- 'welch_t_approx' for medians / means (close_probability, days_to_book).
- 'simple_lift' as a fallback when no rigorous test fits — explicitly flagged as "n + lift only" in the result.

MINIMUM_N
- Conversion-rate tests: 10 per cohort minimum, 20 preferred.
- Median tests: 5 per cohort minimum, 10 preferred.
- Below minimum_n on either side, the interpreter labels data_too_thin.

EXPECTED LIFT THRESHOLD
- For 'higher' / 'lower' direction: pick a meaningful effect size (15-50% typical for venue-scale cohorts). Smaller lifts are noise at these sample sizes.
- For 'equal' direction: pick the FAILURE threshold (e.g. 25%). If observed |lift| >= threshold, the equivalence hypothesis is refuted.

REFUSAL DISCIPLINE
- If the hypothesis isn't testable with the data Bloom has (e.g. asks about psychology that requires a survey), refuse: emit refusals=[{field:'test_plan', reason:'untestable with available data'}] and a placeholder test_plan with test_kind='custom'.
- If the cohort is too small (< 20 couples total), refuse: refusals=[{field:'test_plan', reason:'cohort too small'}].

OUTPUT — JSON only, exactly this shape:
{
  "test_plan": {
    "test_kind": "cohort_comparison" | "time_shift" | "channel_comparison" | "custom",
    "treatment_cohort_filter": { ... },
    "control_cohort_filter": { ... },
    "metric": "<metric name>",
    "direction_if_confirmed": "higher" | "lower" | "equal",
    "minimum_n": <int>,
    "statistical_test": "two_proportion_z" | "welch_t_approx" | "simple_lift",
    "expected_lift_threshold_pct": <number>
  },
  "reasoning": "<one paragraph explaining the choices>",
  "refusals": [{ "field": "<field>", "reason": "<reason>" }]
}

DO NOT
- Output prose outside the JSON.
- Pick a metric the executor cannot compute (anything not in the recognised list above unless test_kind='custom').
- Auto-execute. You only design.
- Assume the data has a column it does not have. The recognised filter shapes above are exhaustive for v1.`
}

export function buildHypothesisDesignerUserPrompt(
  evidence: DesignerEvidence,
): string {
  const lines: string[] = []
  lines.push('HYPOTHESIS')
  lines.push(`title: ${evidence.hypothesis_title}`)
  lines.push(`category: ${evidence.hypothesis_category}`)
  lines.push(`text: ${evidence.hypothesis_text}`)
  if (evidence.recommended_test) {
    lines.push(`recommended_test (free-text from Wave 7A):`)
    lines.push(evidence.recommended_test)
  }
  lines.push('')

  lines.push('EVIDENCE SUMMARY (anonymised)')
  if (evidence.evidence_signal_type) {
    lines.push(`signal_type: ${evidence.evidence_signal_type}`)
  }
  if (evidence.evidence_n_couples !== null) {
    lines.push(`n_couples_in_evidence: ${evidence.evidence_n_couples}`)
  }
  lines.push(`total_couples_in_cohort: ${evidence.total_couples_in_cohort}`)
  lines.push('')

  lines.push('CHANNEL × ROLE SUMMARY (anonymised)')
  if (evidence.channel_role_summary.length === 0) {
    lines.push('(none — attribution_events.role may not have populated yet)')
  } else {
    for (const c of evidence.channel_role_summary) {
      lines.push(
        `- ${c.source_platform}: acq=${c.acquisition_count} val=${c.validation_count} conv=${c.conversion_count}`,
      )
    }
  }
  lines.push('')

  lines.push('PERSONA LABELS PRESENT')
  if (evidence.persona_labels.length === 0) {
    lines.push('(none yet)')
  } else {
    for (const p of evidence.persona_labels) {
      lines.push(`- ${p}`)
    }
  }
  lines.push('')

  lines.push(
    'Translate the hypothesis into a structured test plan. Honour the recognised filter / metric / statistical_test enums above. Refuse cleanly if the hypothesis is untestable with available data — refusal beats fabricated tests.',
  )
  lines.push('Return JSON only, no prose preamble, no markdown fences.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Interpreter prompt
// ---------------------------------------------------------------------------

export interface InterpreterEvidence {
  hypothesis_title: string
  hypothesis_text: string
  test_plan: HypothesisTestPlan
  test_result: HypothesisTestResultNumbers
}

export function buildHypothesisInterpreterSystemPrompt(): string {
  return `You are Bloom's hypothesis result interpreter. Given a hypothesis, the test plan that was designed for it, and the numerical result the executor returned, you output a CATEGORICAL VERDICT.

YOUR JOB
- Read the hypothesis + test plan + result numbers.
- Decide one of: validated | refuted | inconclusive | data_too_thin.
- Output a confidence (0-100) reflecting how cleanly the numbers support the verdict.
- Output a brief reasoning chain explaining why you picked this verdict.
- Optionally suggest a follow-up if the verdict is inconclusive (e.g. "wait for n_treatment to grow past 20 then re-run").

VERDICT RULES
- 'data_too_thin' — n_treatment < minimum_n OR n_control < minimum_n OR test_result.errors is non-empty in a way that prevented the metric from being computed. Confidence reflects how confident we are that "the test could not produce a usable result".
- 'inconclusive' — the test ran cleanly but lift_pct is below expected_lift_threshold_pct AND p_value_approx is high (> 0.2). The pattern Wave 7A spotted is not present in the data within tolerance. Distinct from 'refuted' because the data also doesn't strongly contradict the hypothesis — there's just no clear signal either way.
- 'refuted' — the metric moved in the OPPOSITE direction from direction_if_confirmed by more than expected_lift_threshold_pct. Confidence reflects how cleanly opposite + how large the n.
- 'validated' — the metric moved in the EXPECTED direction by at least expected_lift_threshold_pct AND (n_treatment + n_control) >= 2× minimum_n. For direction='equal', validation means |lift_pct| < expected_lift_threshold_pct (a "no-difference" hypothesis is confirmed when there's no meaningful difference).

P-VALUE WEIGHTING
- The p_value_approx is BEST-EFFORT — Wave 7C does not pull a stats library, so the executor uses simple binomial / t-approximations. Treat it as a soft signal, not a hard threshold. Lean on n + lift.
- A p_value_approx of 0.04 is suggestive, not conclusive at venue-scale n's. Weight it less than effect size.

CONFIDENCE 0-100
- 90+ — overwhelming numbers (n >> minimum_n, lift >> threshold, low p_value_approx)
- 70-89 — clear signal but moderate n
- 50-69 — directionally suggestive
- 30-49 — weak signal, prefer 'inconclusive' as the verdict
- < 30 — verdict is barely defensible; consider whether 'inconclusive' or 'data_too_thin' is more honest

FOLLOW-UP RECOMMENDATIONS
- For inconclusive verdicts: suggest a re-run condition (n threshold, time window).
- For validated verdicts: optionally suggest a deeper test the operator could run to confirm.
- For refuted: optional, often null.
- For data_too_thin: tell the operator what they need to wait for.

DO NOT
- Re-run the test. You only label what the executor produced.
- Reference couples by name. The data is anonymised; treat all references as "the treatment cohort" / "the control cohort" / "the group with persona X".
- Round n's. Honest n's are part of the verdict's credibility.

OUTPUT — JSON only, exactly this shape:
{
  "interpretation": "validated" | "refuted" | "inconclusive" | "data_too_thin",
  "confidence_0_100": <int>,
  "reasoning": "<paragraph explaining why you picked this verdict, citing the specific numbers>",
  "recommended_followup": "<optional next step, or null>",
  "refusals": [{ "field": "<field>", "reason": "<reason>" }]
}`
}

export function buildHypothesisInterpreterUserPrompt(
  evidence: InterpreterEvidence,
): string {
  const lines: string[] = []
  lines.push('HYPOTHESIS')
  lines.push(`title: ${evidence.hypothesis_title}`)
  lines.push(`text: ${evidence.hypothesis_text}`)
  lines.push('')

  lines.push('TEST PLAN (from designer)')
  lines.push(`test_kind: ${evidence.test_plan.test_kind}`)
  lines.push(`metric: ${evidence.test_plan.metric}`)
  lines.push(`direction_if_confirmed: ${evidence.test_plan.direction_if_confirmed}`)
  lines.push(`minimum_n: ${evidence.test_plan.minimum_n}`)
  lines.push(`statistical_test: ${evidence.test_plan.statistical_test}`)
  lines.push(
    `expected_lift_threshold_pct: ${evidence.test_plan.expected_lift_threshold_pct}`,
  )
  lines.push(
    `treatment_cohort_filter: ${JSON.stringify(evidence.test_plan.treatment_cohort_filter)}`,
  )
  lines.push(
    `control_cohort_filter: ${JSON.stringify(evidence.test_plan.control_cohort_filter)}`,
  )
  lines.push('')

  lines.push('TEST RESULT (from executor)')
  lines.push(
    `metric_value_treatment: ${formatNumberOrNull(evidence.test_result.metric_value_treatment)}`,
  )
  lines.push(
    `metric_value_control: ${formatNumberOrNull(evidence.test_result.metric_value_control)}`,
  )
  lines.push(`lift_pct: ${formatNumberOrNull(evidence.test_result.lift_pct)}`)
  lines.push(`n_treatment: ${evidence.test_result.n_treatment}`)
  lines.push(`n_control: ${evidence.test_result.n_control}`)
  lines.push(
    `p_value_approx: ${formatNumberOrNull(evidence.test_result.p_value_approx)}`,
  )
  lines.push(
    `statistical_test_used: ${evidence.test_result.statistical_test_used}`,
  )
  if (evidence.test_result.errors.length > 0) {
    lines.push('errors:')
    for (const e of evidence.test_result.errors) lines.push(`- ${e}`)
  } else {
    lines.push('errors: (none)')
  }
  lines.push('')

  lines.push(
    'Output the categorical verdict (validated / refuted / inconclusive / data_too_thin), confidence, reasoning, and optional follow-up. Be honest — refusal/data_too_thin beats over-claiming a verdict the numbers do not support.',
  )
  lines.push('Return JSON only, no prose preamble, no markdown fences.')
  return lines.join('\n')
}

function formatNumberOrNull(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'null'
  if (!Number.isFinite(value)) return 'null'
  // Display with up to 4 decimals so p-values render usefully.
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

// ---------------------------------------------------------------------------
// Output validation — designer
// ---------------------------------------------------------------------------

const RECOGNISED_TEST_KINDS: ReadonlySet<HypothesisTestKind> = new Set([
  'cohort_comparison',
  'time_shift',
  'channel_comparison',
  'custom',
])

const RECOGNISED_DIRECTIONS: ReadonlySet<ExpectedDirection> = new Set([
  'higher',
  'lower',
  'equal',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validateHypothesisDesignerOutput(
  raw: unknown,
):
  | { ok: true; output: HypothesisTestDesignOutput }
  | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'output is not an object' }
  }

  const planRaw = raw['test_plan']
  if (!isPlainObject(planRaw)) {
    return { ok: false, error: 'test_plan missing or not an object' }
  }

  const testKind = planRaw['test_kind']
  if (
    typeof testKind !== 'string' ||
    !RECOGNISED_TEST_KINDS.has(testKind as HypothesisTestKind)
  ) {
    return { ok: false, error: `test_plan.test_kind invalid: ${String(testKind)}` }
  }

  const treatmentFilter = planRaw['treatment_cohort_filter']
  if (!isPlainObject(treatmentFilter)) {
    return {
      ok: false,
      error: 'test_plan.treatment_cohort_filter must be an object',
    }
  }

  const controlFilter = planRaw['control_cohort_filter']
  if (!isPlainObject(controlFilter)) {
    return {
      ok: false,
      error: 'test_plan.control_cohort_filter must be an object',
    }
  }

  const metric = planRaw['metric']
  if (typeof metric !== 'string' || metric.length === 0) {
    return { ok: false, error: 'test_plan.metric missing' }
  }

  const direction = planRaw['direction_if_confirmed']
  if (
    typeof direction !== 'string' ||
    !RECOGNISED_DIRECTIONS.has(direction as ExpectedDirection)
  ) {
    return {
      ok: false,
      error: `test_plan.direction_if_confirmed invalid: ${String(direction)}`,
    }
  }

  const minimumN = Number(planRaw['minimum_n'])
  if (!Number.isFinite(minimumN) || minimumN < 0) {
    return { ok: false, error: 'test_plan.minimum_n invalid' }
  }

  const statisticalTest = planRaw['statistical_test']
  if (typeof statisticalTest !== 'string' || statisticalTest.length === 0) {
    return { ok: false, error: 'test_plan.statistical_test missing' }
  }

  const expectedLift = Number(planRaw['expected_lift_threshold_pct'])
  if (!Number.isFinite(expectedLift) || expectedLift < 0) {
    return {
      ok: false,
      error: 'test_plan.expected_lift_threshold_pct invalid',
    }
  }

  const reasoningRaw = raw['reasoning']
  const reasoning = typeof reasoningRaw === 'string' ? reasoningRaw : ''

  const refusalsRaw = raw['refusals']
  const refusals: Array<{ field: string; reason: string }> = []
  if (Array.isArray(refusalsRaw)) {
    for (const x of refusalsRaw) {
      if (!isPlainObject(x)) continue
      const field = x['field']
      const reason = x['reason']
      if (typeof field === 'string' && typeof reason === 'string') {
        refusals.push({ field, reason })
      }
    }
  }

  return {
    ok: true,
    output: {
      test_plan: {
        test_kind: testKind as HypothesisTestKind,
        treatment_cohort_filter: treatmentFilter,
        control_cohort_filter: controlFilter,
        metric: metric.slice(0, 100),
        direction_if_confirmed: direction as ExpectedDirection,
        minimum_n: Math.max(0, Math.round(minimumN)),
        statistical_test: statisticalTest.slice(0, 100),
        expected_lift_threshold_pct: expectedLift,
      },
      reasoning,
      refusals,
    },
  }
}

// ---------------------------------------------------------------------------
// Output validation — interpreter
// ---------------------------------------------------------------------------

const RECOGNISED_INTERPRETATIONS: ReadonlySet<HypothesisInterpretation> =
  new Set(['validated', 'refuted', 'inconclusive', 'data_too_thin'])

export function validateHypothesisInterpreterOutput(
  raw: unknown,
):
  | { ok: true; output: HypothesisInterpretationOutput }
  | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'output is not an object' }
  }

  const interpretation = raw['interpretation']
  if (
    typeof interpretation !== 'string' ||
    !RECOGNISED_INTERPRETATIONS.has(interpretation as HypothesisInterpretation)
  ) {
    return {
      ok: false,
      error: `interpretation invalid: ${String(interpretation)}`,
    }
  }

  const conf = Number(raw['confidence_0_100'])
  if (!Number.isFinite(conf) || conf < 0 || conf > 100) {
    return { ok: false, error: 'confidence_0_100 invalid' }
  }

  const reasoningRaw = raw['reasoning']
  const reasoning = typeof reasoningRaw === 'string' ? reasoningRaw : ''

  const followupRaw = raw['recommended_followup']
  const recommendedFollowup =
    typeof followupRaw === 'string' && followupRaw.length > 0
      ? followupRaw
      : null

  const refusalsRaw = raw['refusals']
  const refusals: Array<{ field: string; reason: string }> = []
  if (Array.isArray(refusalsRaw)) {
    for (const x of refusalsRaw) {
      if (!isPlainObject(x)) continue
      const field = x['field']
      const reason = x['reason']
      if (typeof field === 'string' && typeof reason === 'string') {
        refusals.push({ field, reason })
      }
    }
  }

  return {
    ok: true,
    output: {
      interpretation: interpretation as HypothesisInterpretation,
      confidence_0_100: Math.round(conf),
      reasoning,
      recommended_followup: recommendedFollowup,
      refusals,
    },
  }
}
