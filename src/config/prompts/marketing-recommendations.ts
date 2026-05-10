/**
 * Bloom House — Wave 6C marketing reallocation recommendations prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6 closes the forensic loop. Wave 6B
 *     produces the persona × channel × ROI matrix; Wave 6C turns it into
 *     specific reallocation recommendations a coordinator can audit.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 6C spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The judge
 *     receives only anonymised aggregate cells + cohort summaries; no
 *     per-couple PII reaches this prompt.)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; Wave 6C is a Sonnet analyst).
 *
 * Why this prompt is the analyst not the autopilot
 * ------------------------------------------------
 * The system never auto-spends. The LLM's job is to produce 3-5
 * specific, evidence-cited reallocation recommendations the operator
 * decides on. Each recommendation must:
 *   - cite SPECIFIC numbers from the rollup (CAC of channel A vs CAC of
 *     channel B for the same persona)
 *   - include a counterfactual ("what happens if we DON'T reallocate")
 *   - include a payback timeline ("impact starts ~2 months in,
 *     cumulative payback at month 5")
 *   - flag n_too_small_warning when the source/target cohort < 10
 *
 * Refusal discipline
 * ------------------
 * Refuse when:
 *   - cohort substrate is too thin (no rollup cells with n ≥ 10, or no
 *     persona overlay attached anywhere)
 *   - candidate source/target cells have < 10 weddings
 *   - the data is too uniform to recommend a reallocation
 * Refusal beats fabricated recommendations. The caller stores the
 * refusal string in the refusals array; UI surfaces "no actionable
 * recommendations yet — need more data".
 *
 * Output: ONLY the JSON object. No prose preamble, no markdown fences.
 */

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const MARKETING_RECOMMENDATIONS_PROMPT_VERSION =
  'marketing-recommendations.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export type RecommendationActionType =
  | 'reallocate'
  | 'pause'
  | 'scale'
  | 'investigate'
  | 'other'

export interface ReasoningChain {
  /** Specific cell numbers cited from the rollup matrix. */
  evidence_signals: string[]
  /** What the recommendation assumes "today" looks like. */
  assumed_baseline: string
  /** What the recommendation predicts post-action. */
  projected_outcome: string
  /** What happens if we DON'T reallocate. */
  counterfactual: string
  /** Months until projected impact materialises. */
  payback_months: number
  /** What could falsify the projection. */
  key_risks: string[]
}

export interface MarketingRecommendation {
  recommendation_title: string
  recommendation_text: string
  action_type: RecommendationActionType
  source_channel: string | null
  target_channel: string | null
  target_persona: string | null
  estimated_monthly_dollar_impact_cents: number
  confidence_0_100: number
  reasoning_chain: ReasoningChain
  n_too_small_warning: boolean
}

export interface RecommendationRefusal {
  field: string
  reason: string
}

export interface MarketingRecommendationsOutput {
  recommendations: MarketingRecommendation[]
  refusals: RecommendationRefusal[]
}

// ---------------------------------------------------------------------------
// Evidence types — shape the user prompt serialises.
// ---------------------------------------------------------------------------

export interface RollupCellEvidence {
  channel: string
  persona_label: string | null
  window_days: number
  spend_cents: number
  inquiries_count: number
  booked_count: number
  total_booked_value_cents: number
  cac_cents: number | null
  conversion_pct: number | null
  roi_pct: number | null
  payback_months: number | null
  n_too_small: boolean
}

export interface CohortPersonaShareEvidence {
  persona_label: string
  share_pct: number
  n_couples: number
}

export interface CohortThemeShareEvidence {
  theme: string
  trend: 'rising' | 'steady' | 'declining' | 'unknown'
  evidence_count: number
}

export interface ExternalSignalSummaryEvidence {
  signal_type: string
  title: string
  cohort_fit_score_0_100: number | null
  reasoning_brief: string | null
}

export interface AttributionRoleSummaryEvidence {
  channel: string
  acquisition_count: number
  validation_count: number
  conversion_count: number
}

export interface MarketingRecommendationsEvidence {
  venueId: string
  venueLabel: string | null
  windowDays: number
  /** Total weddings in the cohort window — used to ground n_too_small. */
  totalCouplesInCohort: number
  /** Latest 90-day rollup cells. Aggregated already; no per-couple PII. */
  rollupCells: RollupCellEvidence[]
  /** Anonymised persona shares from couple_intel + venue_intel. */
  personaDistribution: CohortPersonaShareEvidence[]
  /** Anonymised emerging themes (sensitive ones already filtered). */
  emergingThemes: CohortThemeShareEvidence[]
  /** Recent external signals (Wave 5C intel_matches). */
  externalSignals: ExternalSignalSummaryEvidence[]
  /** Channel-role distribution (Wave 7B attribution_events.role). */
  attributionRoles: AttributionRoleSummaryEvidence[]
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildMarketingRecommendationsSystemPrompt(): string {
  return `You are Bloom's marketing reallocation analyst.

Given a venue's persona × channel × revenue rollup matrix + cohort intel + external signals, produce 3-5 specific reallocation recommendations. The operator reads your output and decides what to do — you are NOT the autopilot, you are the analyst.

ANONYMISATION DISCIPLINE
- The cohort context is already anonymised. You do NOT see couple names, partner names, emails, or evidence quotes.
- You see persona LABELS + SHARES, channel NAMES, aggregate cell numbers (CAC / conversion / ROI / spend / booked).
- You will not be given any per-couple PII. If you would normally cite a couple, cite the rollup cell instead ("Knot × Heritage-Forward, n=14, CAC=$180").

HARD RULES
1. Each recommendation MUST cite SPECIFIC numbers from the rollup. NOT "Knot is expensive" but "Knot × Heritage-Forward CAC=$180 vs Instagram × Heritage-Forward CAC=$90 (over the same 90d window, n_knot=14, n_instagram=22)".
2. Counterfactual is mandatory: explicitly state what happens if we DON'T reallocate (status quo cost, lost upside).
3. Payback timeline is mandatory: how long until projected impact starts to materialise + when cumulative payback breaks even.
4. n_too_small_warning=true when EITHER the source cell OR the target cell underlying your recommendation has < 10 weddings (sum of inquiries_count + booked_count < 10). When you set this flag, your confidence MUST be < 70.
5. NEVER recommend auto-execution. Frame recommendations as "Move 30% of Knot spend to Instagram" or "Pause Hitched until cell n grows" — never "Auto-reallocating now".
6. estimated_monthly_dollar_impact_cents must be a SIGNED integer. Positive for upside, negative for cost the operator absorbs (revenue loss from a pause). Cents not dollars.
7. action_type must be one of: reallocate | pause | scale | investigate | other. Use 'investigate' when the data is too thin or contradictory to recommend a spend move.

REFUSAL DISCIPLINE
Set refusals=[{field, reason}] when:
- No rollup cells have n ≥ 10 (cohort substrate too thin globally — refuse all recs).
- Persona distribution is empty (no Wave 5A overlay yet — refuse persona-targeted recs).
- All cells share the same channel (no reallocation target available).
- Data is contradictory (e.g. attribution credits Knot but spend records show $0 to Knot).

Refuse honestly. If you can produce 1 strong rec + 4 refusals, do that. Better to refuse than to fabricate confidence.

REASONING CHAIN
For each recommendation, populate reasoning_chain with:
- evidence_signals: 2-5 specific cell numbers cited (e.g. "Knot × Heritage-Forward CAC=$180 (n=14)").
- assumed_baseline: 1-2 sentences of what "today" looks like for the recommended segment.
- projected_outcome: 1-2 sentences of what changes after the reallocation.
- counterfactual: 1-2 sentences of what happens if no action is taken.
- payback_months: integer or decimal (e.g. 2 or 4.5). When uncertain, take the longer estimate.
- key_risks: 1-3 bullet-style strings naming what could falsify the projection (cohort drift, spend lag, channel volatility).

CONFIDENCE GUIDANCE
- 80-100: clear ROI gap (≥3x), n ≥ 10 in both cells, consistent across windows.
- 60-79: meaningful ROI gap (≥1.5x), n ≥ 10 in both cells, single window.
- 40-59: directional signal, n marginal (≥5), or only one window of data.
- 20-39: weak signal — lean toward 'investigate' action_type.
- 0-19: refuse instead of recommending.

OUTPUT — JSON only, exactly this shape:
{
  "recommendations": [
    {
      "recommendation_title": "Move 30% of Knot spend to Instagram for Heritage-Forward",
      "recommendation_text": "Knot × Heritage-Forward (n=14) shows CAC=$180 and 8% conversion. Instagram × Heritage-Forward (n=22) shows CAC=$90 and 22% conversion in the same 90-day window. Reallocating $800/mo of Knot spend to Instagram is projected to add 2-3 bookings/mo at the same total spend, ~+$14k/yr at the venue's current avg booking value.",
      "action_type": "reallocate",
      "source_channel": "theknot_fee",
      "target_channel": "meta_ads",
      "target_persona": "Heritage-Forward",
      "estimated_monthly_dollar_impact_cents": 1166000,
      "confidence_0_100": 78,
      "reasoning_chain": {
        "evidence_signals": [
          "Knot × Heritage-Forward: CAC=$180 conversion=8% (n=14)",
          "Instagram × Heritage-Forward: CAC=$90 conversion=22% (n=22)"
        ],
        "assumed_baseline": "Knot currently absorbs $2,600/mo at $180 CAC; that's 14 bookings/qtr. Instagram absorbs $1,800/mo at $90 CAC; that's 22 bookings/qtr.",
        "projected_outcome": "Shifting $800/mo from Knot to Instagram trades ~1.5 expensive bookings for ~3 cheaper ones. Net +1.5 bookings/mo at the venue's $9,300 avg.",
        "counterfactual": "If we don't reallocate, the Heritage-Forward inquiries from Knot continue to underperform; we leave the Instagram leverage on the table.",
        "payback_months": 2,
        "key_risks": [
          "Instagram CAC may drift up if spend doubles",
          "Knot validation effect — some Instagram leads may visit Knot before booking; pulling Knot entirely could quietly drag conversions"
        ]
      },
      "n_too_small_warning": false
    }
  ],
  "refusals": [
    { "field": "tiktok_ads", "reason": "Only 3 weddings attributed in 90d — refuse recommendation; n_too_small" }
  ]
}

DO NOT:
- Echo persona labels or channel names outside the structured fields above.
- Invent persona labels that did not appear in personaDistribution.
- Speculate about specific couples — you have no per-couple data.
- Recommend auto-execution. Always frame as "flag for coordinator decision".
- Produce a recommendation without a counterfactual + payback_months.`
}

export function buildMarketingRecommendationsUserPrompt(
  evidence: MarketingRecommendationsEvidence,
): string {
  const lines: string[] = []
  lines.push(`VENUE`)
  lines.push(`venueLabel: ${evidence.venueLabel ?? '<unknown>'}`)
  lines.push(`windowDays: ${evidence.windowDays}`)
  lines.push(`totalCouplesInCohort: ${evidence.totalCouplesInCohort}`)
  lines.push('')

  lines.push(`PERSONA DISTRIBUTION (anonymised, latest 90d)`)
  if (evidence.personaDistribution.length === 0) {
    lines.push('(empty — no Wave 5A overlay yet; refuse persona-targeted recs)')
  } else {
    for (const p of evidence.personaDistribution) {
      lines.push(
        `- ${p.persona_label} | share=${p.share_pct}% | n=${p.n_couples}`,
      )
    }
  }
  lines.push('')

  lines.push(`EMERGING THEMES (non-sensitive only)`)
  if (evidence.emergingThemes.length === 0) {
    lines.push('(none surfaced)')
  } else {
    for (const t of evidence.emergingThemes) {
      lines.push(
        `- ${t.theme} | trend=${t.trend} | n=${t.evidence_count}`,
      )
    }
  }
  lines.push('')

  lines.push(`ROLLUP CELLS (persona × channel × ROI, latest computed window)`)
  if (evidence.rollupCells.length === 0) {
    lines.push('(empty — no rollup yet; refuse all recs)')
  } else {
    for (const c of evidence.rollupCells) {
      const persona = c.persona_label ?? '__untagged__'
      const cac = c.cac_cents === null ? '—' : `$${(c.cac_cents / 100).toFixed(0)}`
      const conv =
        c.conversion_pct === null ? '—' : `${c.conversion_pct.toFixed(1)}%`
      const roi = c.roi_pct === null ? '—' : `${c.roi_pct.toFixed(1)}%`
      const pb =
        c.payback_months === null ? '—' : `${c.payback_months.toFixed(1)}mo`
      const spend = `$${(c.spend_cents / 100).toFixed(0)}`
      const tooSmall = c.n_too_small ? ' [n_too_small]' : ''
      lines.push(
        `- ${c.channel} × ${persona} | spend=${spend} | inq=${c.inquiries_count} booked=${c.booked_count} | CAC=${cac} conv=${conv} ROI=${roi} payback=${pb}${tooSmall}`,
      )
    }
  }
  lines.push('')

  lines.push(`EXTERNAL SIGNALS (Wave 5C cohort-fit scoring, recent)`)
  if (evidence.externalSignals.length === 0) {
    lines.push('(none scored)')
  } else {
    for (const s of evidence.externalSignals.slice(0, 8)) {
      const fit =
        s.cohort_fit_score_0_100 === null
          ? '—'
          : `${s.cohort_fit_score_0_100}/100`
      lines.push(
        `- ${s.signal_type}: ${s.title} | fit=${fit}${s.reasoning_brief ? ` | ${s.reasoning_brief}` : ''}`,
      )
    }
  }
  lines.push('')

  lines.push(`ATTRIBUTION ROLE DISTRIBUTION (Wave 7B, last 90d)`)
  if (evidence.attributionRoles.length === 0) {
    lines.push('(none classified yet)')
  } else {
    for (const r of evidence.attributionRoles) {
      lines.push(
        `- ${r.channel}: acquisition=${r.acquisition_count} validation=${r.validation_count} conversion=${r.conversion_count}`,
      )
    }
  }
  lines.push('')

  lines.push(
    `Produce 3-5 specific reallocation recommendations. Apply refusal discipline when cohort cells are too small or data is contradictory. Each recommendation MUST cite specific cell numbers, MUST include a counterfactual + payback timeline, and MUST set n_too_small_warning when source/target cohort < 10.`,
  )
  lines.push(`Return JSON only, no prose preamble, no markdown fences.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

const VALID_ACTION_TYPES: ReadonlySet<RecommendationActionType> = new Set([
  'reallocate',
  'pause',
  'scale',
  'investigate',
  'other',
])

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  return value.every((v) => typeof v === 'string')
}

function validateReasoningChain(
  raw: unknown,
):
  | { ok: true; chain: ReasoningChain }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'reasoning_chain is not an object' }
  }
  const r = raw as Record<string, unknown>

  if (!isStringArray(r['evidence_signals'])) {
    return { ok: false, error: 'evidence_signals missing or not string[]' }
  }
  const evidenceSignals = r['evidence_signals'] as string[]

  if (typeof r['assumed_baseline'] !== 'string') {
    return { ok: false, error: 'assumed_baseline missing' }
  }
  if (typeof r['projected_outcome'] !== 'string') {
    return { ok: false, error: 'projected_outcome missing' }
  }
  if (typeof r['counterfactual'] !== 'string') {
    return { ok: false, error: 'counterfactual missing' }
  }

  const payback = r['payback_months']
  if (typeof payback !== 'number' || !Number.isFinite(payback)) {
    return { ok: false, error: 'payback_months missing or non-numeric' }
  }

  if (!isStringArray(r['key_risks'])) {
    return { ok: false, error: 'key_risks missing or not string[]' }
  }
  const keyRisks = r['key_risks'] as string[]

  return {
    ok: true,
    chain: {
      evidence_signals: evidenceSignals,
      assumed_baseline: r['assumed_baseline'] as string,
      projected_outcome: r['projected_outcome'] as string,
      counterfactual: r['counterfactual'] as string,
      payback_months: payback,
      key_risks: keyRisks,
    },
  }
}

function validateRecommendation(
  raw: unknown,
):
  | { ok: true; rec: MarketingRecommendation }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'recommendation is not an object' }
  }
  const r = raw as Record<string, unknown>

  const title = r['recommendation_title']
  if (typeof title !== 'string' || title.length === 0) {
    return { ok: false, error: 'recommendation_title missing' }
  }
  const text = r['recommendation_text']
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: 'recommendation_text missing' }
  }
  const action = r['action_type']
  if (
    typeof action !== 'string' ||
    !VALID_ACTION_TYPES.has(action as RecommendationActionType)
  ) {
    return { ok: false, error: `action_type invalid: ${String(action)}` }
  }

  const sourceChannel =
    typeof r['source_channel'] === 'string' ? (r['source_channel'] as string) : null
  const targetChannel =
    typeof r['target_channel'] === 'string' ? (r['target_channel'] as string) : null
  const targetPersona =
    typeof r['target_persona'] === 'string' ? (r['target_persona'] as string) : null

  const impact = r['estimated_monthly_dollar_impact_cents']
  if (typeof impact !== 'number' || !Number.isFinite(impact)) {
    return {
      ok: false,
      error: 'estimated_monthly_dollar_impact_cents missing or non-numeric',
    }
  }

  const confidence = r['confidence_0_100']
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    return { ok: false, error: 'confidence_0_100 invalid' }
  }

  const chainValidation = validateReasoningChain(r['reasoning_chain'])
  if (!chainValidation.ok) {
    return { ok: false, error: `reasoning_chain: ${chainValidation.error}` }
  }

  const tooSmall = r['n_too_small_warning']
  const nTooSmall = typeof tooSmall === 'boolean' ? tooSmall : false

  return {
    ok: true,
    rec: {
      recommendation_title: title.slice(0, 200),
      recommendation_text: text,
      action_type: action as RecommendationActionType,
      source_channel: sourceChannel,
      target_channel: targetChannel,
      target_persona: targetPersona,
      estimated_monthly_dollar_impact_cents: Math.round(impact),
      confidence_0_100: Math.round(confidence),
      reasoning_chain: chainValidation.chain,
      n_too_small_warning: nTooSmall,
    },
  }
}

export function validateMarketingRecommendationsOutput(
  raw: unknown,
):
  | { ok: true; output: MarketingRecommendationsOutput }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'output is not an object' }
  }
  const r = raw as Record<string, unknown>

  const recsRaw = r['recommendations']
  if (!Array.isArray(recsRaw)) {
    return { ok: false, error: 'recommendations is not an array' }
  }
  const recommendations: MarketingRecommendation[] = []
  for (let i = 0; i < recsRaw.length; i++) {
    const v = validateRecommendation(recsRaw[i])
    if (!v.ok) {
      return {
        ok: false,
        error: `recommendations[${i}]: ${v.error}`,
      }
    }
    recommendations.push(v.rec)
  }

  const refusalsRaw = r['refusals']
  const refusals: RecommendationRefusal[] = []
  if (Array.isArray(refusalsRaw)) {
    for (const ref of refusalsRaw) {
      if (!ref || typeof ref !== 'object') continue
      const refObj = ref as Record<string, unknown>
      const field = refObj['field']
      const reason = refObj['reason']
      if (typeof field === 'string' && typeof reason === 'string') {
        refusals.push({ field, reason })
      }
    }
  }

  return { ok: true, output: { recommendations, refusals } }
}
