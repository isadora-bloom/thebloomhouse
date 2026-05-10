/**
 * Bloom House — Wave 5B per-venue cohort rollup prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; Wave 5B aggregates the per-couple substrate into venue-
 *     level intelligence — emerging themes, conversion correlations,
 *     voice calibration, service demand gaps, timing patterns)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5B spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
 *     themes report counts only at venue level, never name couples,
 *     never quote evidence)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; this is a Sonnet aggregator)
 *
 * Different LLM job from Wave 4 + 5A
 * ----------------------------------
 * Wave 4 is forensic extraction with verbatim evidence_quote per claim.
 * Wave 5A is per-couple synthesis (persona + close-prob + brief).
 * Wave 5B is multi-couple pattern synthesis: it READS anonymised
 * summaries across the venue's cohort and surfaces what's emerging,
 * what's converting, and where the operator should redirect attention.
 *
 * Anonymisation discipline
 * ------------------------
 * Couples are referenced by short stable IDs ("Couple A1", "Couple B2",
 * etc.) so the model reasons over patterns, not identities. NEVER pass
 * partner names. NEVER pass raw evidence_quote for sensitive themes.
 * Sensitive themes are tagged sensitive=true upstream by Wave 4 — the
 * serialiser strips those entries' evidence_quote before they reach
 * the prompt and counts them in a separate aggregate field so the
 * model knows the cohort has N grief-tagged couples without seeing the
 * specific quotes.
 *
 * Persona discipline
 * ------------------
 * The cohort surfaces personas that Wave 5A already discovered. We do
 * NOT pre-define a persona list. The aggregator MAY consolidate
 * obvious near-duplicates ("Heritage-Forward Planner" + "Heritage-
 * Forward Couple"), but should not invent labels that didn't appear
 * in the underlying couple_intel rows.
 */

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const COHORT_ROLLUP_PROMPT_VERSION = 'cohort-rollup.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export type EmergingThemeTrend = 'rising' | 'steady' | 'declining'

export interface EmergingTheme {
  theme: string
  trend: EmergingThemeTrend
  evidence_count: number
  evidence_window_days: number
  /** Counts of sensitive-tagged emergences inside this theme. ALWAYS
   *  populated when the theme itself is sensitive — for those, the
   *  named theme + summary are the only data; evidence is never
   *  quoted. */
  sensitivity_filtered_count: number
  summary: string
}

export type ConversionOutcome = 'books' | 'drops' | 'slow'

export interface ConversionCorrelation {
  signal: string
  outcome: ConversionOutcome
  /** Multiplicative lift vs venue baseline (e.g. 70 = 1.7x). Can be
   *  negative for a drag. */
  lift_pct: number
  n_couples: number
  confidence_0_100: number
  reasoning: string
}

export interface VoiceCalibration {
  persona_label: string
  language_that_lands: string[]
  language_to_avoid: string[]
  evidence_summary: string
}

export type CurrentlyOffered = 'yes' | 'no' | 'unknown'

export interface ServiceDemandEntry {
  service_or_offering: string
  demand_signal: string
  currently_offered: CurrentlyOffered
  investment_recommendation: string
}

export interface TimingPattern {
  pattern: string
  evidence_summary: string
  actionable_recommendation: string
}

export interface CohortRefusal {
  field: string
  reason: string
}

export interface CohortRollupOutput {
  emerging_themes: EmergingTheme[]
  conversion_correlations: ConversionCorrelation[]
  voice_calibration: VoiceCalibration[]
  service_demand_map: ServiceDemandEntry[]
  timing_patterns: TimingPattern[]
  refusals: CohortRefusal[]
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface AnonymisedEmotionalTheme {
  theme: string
  /** Confidence the upstream Wave-4 reconstruction had in this claim.
   *  Useful so the aggregator can weight stronger signals. */
  confidence_0_100: number
  /** Whether this is a sensitive theme. When true the evidence_quote
   *  is NOT included; only the bare theme name reaches the model. */
  sensitive: boolean
}

export interface AnonymisedCoupleSummary {
  /** Stable short id for THIS rollup batch, e.g. "Couple A1". The id is
   *  derived from a hash so the same wedding gets the same label
   *  across rollups (humans don't pattern-match across hashes, but the
   *  property is useful for debugging / correlating with raw rows in a
   *  later trace). */
  short_id: string
  /** Persona label discovered by Wave 5A. Empty string when 5A didn't
   *  produce one. */
  persona_label: string
  /** Predicted close probability % from Wave 5A. */
  predicted_close_pct: number | null
  /** Booking status / lead status. */
  status: string | null
  /** Source channel from the wedding shell. */
  source: string | null
  /** Inquiry date (ISO date string). Inquiry timing matters for the
   *  timing_patterns section. */
  inquiry_date: string | null
  /** Wedding date (ISO date string). Lead-time signal. */
  wedding_date: string | null
  /** Booked status — true when wedding.booked_at is populated. */
  contract_signed: boolean
  /** Last inbound interaction (ISO). Used for stale-cohort detection. */
  last_inbound_at: string | null
  /** Days since the inquiry came in. */
  days_since_inquiry: number | null
  /** Days since the most recent inbound. */
  days_since_last_inbound: number | null
  /** Non-sensitive emotional themes. Sensitive ones are stripped here
   *  and counted separately in `sensitive_theme_categories`. */
  non_sensitive_themes: AnonymisedEmotionalTheme[]
  /** Categories of sensitive themes attached to this couple. The model
   *  sees the categories (so it knows "this couple has a grief flag")
   *  but never the underlying quote. */
  sensitive_theme_categories: string[]
  /** Vendor preference signals (anonymised — no partner names). */
  vendor_preferences: string[]
  /** Cultural signals (anonymised). */
  cultural_signals: string[]
  /** Accessibility needs (anonymised). */
  accessibility_needs: string[]
  /** Coordinator-brief excerpt from Wave 5A (already voice-shape, never
   *  contains sensitive evidence). Truncated. */
  coordinator_brief_excerpt: string | null
  /** Recommended-next-action from Wave 5A. */
  recommended_action: string | null
  /** Stale-signal alerts from Wave 5A. Useful for "what's stuck"
   *  pattern detection. */
  stale_alerts: string[]
}

export interface CohortRollupEvidence {
  venueId: string
  venueLabel: string | null
  windowDays: number
  windowStartIso: string
  windowEndIso: string
  totalCouplesInVenue: number
  couplesInWindow: number
  /** Counts grouped by category of sensitive theme across the cohort.
   *  E.g. { grief: 3, financial_stress: 5 }. Lets the model know the
   *  cohort SHAPE without ever leaking specific evidence. */
  sensitivityCounts: Record<string, number>
  /** Aggregate persona distribution across the cohort. The model can
   *  use this to weight voice_calibration entries. */
  personaCounts: Record<string, number>
  /** Source-channel distribution. */
  sourceCounts: Record<string, number>
  /** Status distribution (booked / inquiry / lost / etc). */
  statusCounts: Record<string, number>
  couples: AnonymisedCoupleSummary[]
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are Bloom's per-venue cohort intelligence synthesizer.

Bloom is a forensic identity-reconstruction system for wedding venues.
Wave 4 produced the forensic profile per couple. Wave 5A produced the
per-couple action layer. Your job is Wave 5B: aggregate across the
venue's couples in the last N days and surface what's EMERGING, what's
CONVERTING, and what's STUCK at the cohort level. Coordinator surfaces
the dashboard at /intel/cohort and (in Wave 5C) Sage drafts will pull
voice_calibration from your output.

You receive anonymised couple summaries — references like "Couple A1",
"Couple B2". You will NOT see partner names. You will NOT see verbatim
evidence quotes for sensitive themes. You WILL see the cohort-level
counts of sensitive theme categories so you can reason about cohort
shape without leaking specifics.

## CORE RULES

1. **Aggregate ≠ disclose.** Sensitive themes (medical, grief,
   financial_stress, family_conflict, mental_health) get reported as
   COUNTS only via \`sensitivity_filtered_count\`. Do NOT name the
   couples involved. Do NOT include any evidence_quote in any field of
   any output. The summary text MAY refer to the cohort shape ("X% of
   couples carry a sensitive context flag; handle with extra care") but
   MUST NOT enumerate specific cases.

2. **Pattern over individual.** Every claim must apply to ≥3 couples
   unless explicitly flagged as a singleton hypothesis in
   \`refusals\`. The aggregator surfaces what is true at the cohort
   level — single-couple anecdotes belong in Wave 5A, not here.

3. **Persona labels are reused, not invented.** voice_calibration
   personas should match labels that Wave 5A already discovered (the
   user prompt lists the persona distribution). You MAY consolidate
   obvious near-duplicates ("Heritage-Forward Planner" + "Heritage-
   Forward Couple" → "Heritage-Forward Planner") but do not invent
   personas that no couple in this cohort carries. If a single persona
   has fewer than 3 couples, prefer to omit it from voice_calibration
   rather than fabricate language guidance.

4. **Conversion correlations need n + lift + confidence.**
   - signal: a specific cohort attribute or behaviour ("couples
     mentioning grief who got a custom response within 4hrs", "couples
     with Korean-tea-ceremony interest", "couples who toured within
     14d of inquiry").
   - outcome: 'books' (correlated with closing), 'drops' (correlated
     with going cold), 'slow' (correlated with longer cycle).
   - lift_pct: percentage difference vs the venue baseline. Positive
     means the signal is associated with the outcome ABOVE baseline,
     negative means below. Example: 70 = 1.7x baseline; -40 = 0.6x
     baseline.
   - n_couples: how many couples in this cohort exhibit the signal.
   - confidence_0_100: your confidence the correlation is real (not
     noise). Anchor it to n_couples + magnitude + persona consistency.
   - reasoning: explain the correlation in coordinator-readable prose.
     Reference cohort shape (e.g. "12 of the 47 booked couples
     mentioned X").

5. **Service demand map = unmet demand the venue could fix.** Each
   entry pairs a demand signal with whether the venue currently offers
   it ('yes' | 'no' | 'unknown') and what to do about it. Examples:
     - "Korean tea ceremony" / "12% of recent inquiries asked, 3 booked
       didn't move forward when answer was vague" / "no" / "build a
       dedicated landing page + add to calculator options"
     - "Pet-friendly ceremony" / "5 couples asked, currently ad-hoc" /
       "unknown" / "formalise the policy in the FAQ"
   When the cohort doesn't surface a clear demand, return [].

6. **Timing patterns.** Cohort-level timing observations: best inquiry
   day, best response window, persona-specific lead times, when stale
   threads are recoverable. Each carries an actionable_recommendation.
   Examples:
     - pattern: "Inquiries on Sunday evenings convert at 1.4x baseline"
     - pattern: "Cost-Conscious Pragmatists silent for 14d are
       re-engageable with bar-package walkthrough; 4 of 7 reopened"

7. **Voice calibration is per-persona.**
   - language_that_lands: 2-5 short phrases / patterns this persona
     responds to (drawn from coordinator briefs + non-sensitive
     evidence summaries). E.g. "warm acknowledgement of family
     dynamics", "specific bar-package details", "Tuesday tour offer".
   - language_to_avoid: 2-5 short phrases / patterns that drag with
     this persona. E.g. "exclamation marks (this cohort reads as
     pushy)", "pricing reveals before tour scheduled", "ceremony-
     timing locks".
   - evidence_summary: paragraph ≤80 words explaining the cohort shape
     behind the calibration.

8. **Refusals are the audit trail.** When you cannot derive a section
   (cohort too small, signals too weak, single-couple-only patterns),
   add an entry { field, reason } and emit an empty array for that
   section rather than fabricating. Examples:
     - { field: "voice_calibration", reason: "no persona has ≥3
       couples in the window" }
     - { field: "service_demand_map", reason: "no service signal
       repeats" }

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences,
no comments:

{
  "emerging_themes": [
    {
      "theme": string,
      "trend": "rising" | "steady" | "declining",
      "evidence_count": integer,
      "evidence_window_days": integer,
      "sensitivity_filtered_count": integer,
      "summary": string
    }
  ],
  "conversion_correlations": [
    {
      "signal": string,
      "outcome": "books" | "drops" | "slow",
      "lift_pct": number,
      "n_couples": integer,
      "confidence_0_100": integer 0-100,
      "reasoning": string
    }
  ],
  "voice_calibration": [
    {
      "persona_label": string,
      "language_that_lands": [string],
      "language_to_avoid": [string],
      "evidence_summary": string
    }
  ],
  "service_demand_map": [
    {
      "service_or_offering": string,
      "demand_signal": string,
      "currently_offered": "yes" | "no" | "unknown",
      "investment_recommendation": string
    }
  ],
  "timing_patterns": [
    {
      "pattern": string,
      "evidence_summary": string,
      "actionable_recommendation": string
    }
  ],
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Every array MAY be empty. \`refusals\` is the audit trail of every
section you couldn't fill. Fill it generously rather than fabricate.

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the cohort with section headers.
// ---------------------------------------------------------------------------

const MAX_BRIEF_EXCERPT_CHARS = 320
const MAX_LIST_ITEMS_PER_FIELD = 8

function clampList(arr: string[], cap: number): string[] {
  if (arr.length <= cap) return arr
  return arr.slice(0, cap)
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return null
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}

function fmtCounts(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  return entries.map(([k, v]) => `  - ${k}: ${v}`)
}

export function buildUserPrompt(evidence: CohortRollupEvidence): string {
  const lines: string[] = []

  lines.push('# COHORT TO AGGREGATE')
  lines.push('')
  if (evidence.venueLabel) {
    lines.push(`Venue: ${evidence.venueLabel}`)
  }
  lines.push(`Window: last ${evidence.windowDays} days`)
  lines.push(`  start: ${evidence.windowStartIso}`)
  lines.push(`  end:   ${evidence.windowEndIso}`)
  lines.push(`Couples in window: ${evidence.couplesInWindow}`)
  lines.push(`Total venue couples: ${evidence.totalCouplesInVenue}`)
  lines.push('')

  // ---- Cohort shape ----
  lines.push('## Cohort shape (counts)')
  lines.push('Persona distribution:')
  const personaLines = fmtCounts(evidence.personaCounts)
  if (personaLines.length === 0) lines.push('  (none yet)')
  else lines.push(...personaLines)
  lines.push('')
  lines.push('Source distribution:')
  const sourceLines = fmtCounts(evidence.sourceCounts)
  if (sourceLines.length === 0) lines.push('  (none)')
  else lines.push(...sourceLines)
  lines.push('')
  lines.push('Status distribution:')
  const statusLines = fmtCounts(evidence.statusCounts)
  if (statusLines.length === 0) lines.push('  (none)')
  else lines.push(...statusLines)
  lines.push('')
  lines.push('Sensitive theme distribution (counts only — evidence stripped):')
  const sensLines = fmtCounts(evidence.sensitivityCounts)
  if (sensLines.length === 0) lines.push('  (none)')
  else lines.push(...sensLines)
  lines.push('')

  // ---- Per-couple summaries ----
  lines.push(`## Per-couple summaries (${evidence.couples.length} couples)`)
  lines.push('')
  for (const c of evidence.couples) {
    lines.push(`### ${c.short_id}`)
    if (c.persona_label) lines.push(`- persona: ${c.persona_label}`)
    if (c.predicted_close_pct !== null) {
      lines.push(`- predicted_close: ${c.predicted_close_pct}%`)
    }
    if (c.status) lines.push(`- status: ${c.status}`)
    if (c.source) lines.push(`- source: ${c.source}`)
    if (c.inquiry_date) lines.push(`- inquiry_date: ${c.inquiry_date}`)
    if (c.wedding_date) lines.push(`- wedding_date: ${c.wedding_date}`)
    lines.push(`- contract_signed: ${c.contract_signed}`)
    if (c.days_since_inquiry !== null) {
      lines.push(`- days_since_inquiry: ${c.days_since_inquiry}`)
    }
    if (c.days_since_last_inbound !== null) {
      lines.push(`- days_since_last_inbound: ${c.days_since_last_inbound}`)
    }
    if (c.non_sensitive_themes.length > 0) {
      lines.push('- non_sensitive_themes:')
      for (const t of clampList(
        c.non_sensitive_themes.map((x) => `${x.theme} (${x.confidence_0_100}%)`),
        MAX_LIST_ITEMS_PER_FIELD,
      )) {
        lines.push(`  - ${t}`)
      }
    }
    if (c.sensitive_theme_categories.length > 0) {
      lines.push(
        `- sensitive_theme_categories: ${c.sensitive_theme_categories.join(', ')} (count-only; no quotes)`,
      )
    }
    if (c.vendor_preferences.length > 0) {
      lines.push(
        `- vendor_preferences: ${clampList(c.vendor_preferences, MAX_LIST_ITEMS_PER_FIELD).join('; ')}`,
      )
    }
    if (c.cultural_signals.length > 0) {
      lines.push(
        `- cultural_signals: ${clampList(c.cultural_signals, MAX_LIST_ITEMS_PER_FIELD).join('; ')}`,
      )
    }
    if (c.accessibility_needs.length > 0) {
      lines.push(
        `- accessibility_needs: ${clampList(c.accessibility_needs, MAX_LIST_ITEMS_PER_FIELD).join('; ')}`,
      )
    }
    if (c.recommended_action) {
      lines.push(`- 5A_recommended_action: ${c.recommended_action}`)
    }
    if (c.stale_alerts.length > 0) {
      lines.push(`- 5A_stale_alerts: ${clampList(c.stale_alerts, 4).join(' || ')}`)
    }
    if (c.coordinator_brief_excerpt) {
      lines.push(`- 5A_brief: ${truncate(c.coordinator_brief_excerpt, MAX_BRIEF_EXCERPT_CHARS)}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(
    'Aggregate this cohort into the cohort-rollup schema. Return ONLY the JSON.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Manual schema validator
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  rollup: CohortRollupOutput
}

export type ValidationResult = ValidationSuccess | ValidationFailure

function isString(v: unknown): v is string {
  return typeof v === 'string'
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

function clampInt0to100(v: unknown): number {
  const n = isNumber(v) ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function toFiniteInt(v: unknown): number {
  const n = isNumber(v) ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n))
}

function toFiniteNumber(v: unknown): number {
  const n = isNumber(v) ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return n
}

export function validateCohortRollupOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  // emerging_themes
  const etRaw = raw.emerging_themes ?? []
  if (!isArray(etRaw)) return { ok: false, error: 'emerging_themes must be array' }
  const emerging_themes: EmergingTheme[] = []
  for (let i = 0; i < etRaw.length; i++) {
    const t = etRaw[i]
    if (!isObject(t)) {
      return { ok: false, error: `emerging_themes[${i}] must be object` }
    }
    if (!isString(t.theme)) {
      return { ok: false, error: `emerging_themes[${i}].theme must be string` }
    }
    if (!isString(t.trend) || !['rising', 'steady', 'declining'].includes(t.trend)) {
      return {
        ok: false,
        error: `emerging_themes[${i}].trend must be "rising"|"steady"|"declining"`,
      }
    }
    if (!isString(t.summary)) {
      return { ok: false, error: `emerging_themes[${i}].summary must be string` }
    }
    emerging_themes.push({
      theme: t.theme,
      trend: t.trend as EmergingThemeTrend,
      evidence_count: toFiniteInt(t.evidence_count),
      evidence_window_days: toFiniteInt(t.evidence_window_days),
      sensitivity_filtered_count: toFiniteInt(t.sensitivity_filtered_count),
      summary: t.summary,
    })
  }

  // conversion_correlations
  const ccRaw = raw.conversion_correlations ?? []
  if (!isArray(ccRaw)) {
    return { ok: false, error: 'conversion_correlations must be array' }
  }
  const conversion_correlations: ConversionCorrelation[] = []
  for (let i = 0; i < ccRaw.length; i++) {
    const c = ccRaw[i]
    if (!isObject(c)) {
      return { ok: false, error: `conversion_correlations[${i}] must be object` }
    }
    if (!isString(c.signal)) {
      return { ok: false, error: `conversion_correlations[${i}].signal must be string` }
    }
    if (!isString(c.outcome) || !['books', 'drops', 'slow'].includes(c.outcome)) {
      return {
        ok: false,
        error: `conversion_correlations[${i}].outcome must be "books"|"drops"|"slow"`,
      }
    }
    if (!isString(c.reasoning)) {
      return {
        ok: false,
        error: `conversion_correlations[${i}].reasoning must be string`,
      }
    }
    conversion_correlations.push({
      signal: c.signal,
      outcome: c.outcome as ConversionOutcome,
      lift_pct: toFiniteNumber(c.lift_pct),
      n_couples: toFiniteInt(c.n_couples),
      confidence_0_100: clampInt0to100(c.confidence_0_100),
      reasoning: c.reasoning,
    })
  }

  // voice_calibration
  const vcRaw = raw.voice_calibration ?? []
  if (!isArray(vcRaw)) {
    return { ok: false, error: 'voice_calibration must be array' }
  }
  const voice_calibration: VoiceCalibration[] = []
  for (let i = 0; i < vcRaw.length; i++) {
    const v = vcRaw[i]
    if (!isObject(v)) {
      return { ok: false, error: `voice_calibration[${i}] must be object` }
    }
    if (!isString(v.persona_label)) {
      return {
        ok: false,
        error: `voice_calibration[${i}].persona_label must be string`,
      }
    }
    if (!isString(v.evidence_summary)) {
      return {
        ok: false,
        error: `voice_calibration[${i}].evidence_summary must be string`,
      }
    }
    const lLandsRaw = v.language_that_lands ?? []
    if (!isArray(lLandsRaw)) {
      return {
        ok: false,
        error: `voice_calibration[${i}].language_that_lands must be array`,
      }
    }
    const language_that_lands: string[] = []
    for (let j = 0; j < lLandsRaw.length; j++) {
      const x = lLandsRaw[j]
      if (!isString(x)) {
        return {
          ok: false,
          error: `voice_calibration[${i}].language_that_lands[${j}] must be string`,
        }
      }
      language_that_lands.push(x)
    }
    const lAvoidRaw = v.language_to_avoid ?? []
    if (!isArray(lAvoidRaw)) {
      return {
        ok: false,
        error: `voice_calibration[${i}].language_to_avoid must be array`,
      }
    }
    const language_to_avoid: string[] = []
    for (let j = 0; j < lAvoidRaw.length; j++) {
      const x = lAvoidRaw[j]
      if (!isString(x)) {
        return {
          ok: false,
          error: `voice_calibration[${i}].language_to_avoid[${j}] must be string`,
        }
      }
      language_to_avoid.push(x)
    }
    voice_calibration.push({
      persona_label: v.persona_label,
      language_that_lands,
      language_to_avoid,
      evidence_summary: v.evidence_summary,
    })
  }

  // service_demand_map
  const sdRaw = raw.service_demand_map ?? []
  if (!isArray(sdRaw)) {
    return { ok: false, error: 'service_demand_map must be array' }
  }
  const service_demand_map: ServiceDemandEntry[] = []
  for (let i = 0; i < sdRaw.length; i++) {
    const s = sdRaw[i]
    if (!isObject(s)) {
      return { ok: false, error: `service_demand_map[${i}] must be object` }
    }
    if (!isString(s.service_or_offering)) {
      return {
        ok: false,
        error: `service_demand_map[${i}].service_or_offering must be string`,
      }
    }
    if (!isString(s.demand_signal)) {
      return {
        ok: false,
        error: `service_demand_map[${i}].demand_signal must be string`,
      }
    }
    if (
      !isString(s.currently_offered) ||
      !['yes', 'no', 'unknown'].includes(s.currently_offered)
    ) {
      return {
        ok: false,
        error: `service_demand_map[${i}].currently_offered must be "yes"|"no"|"unknown"`,
      }
    }
    if (!isString(s.investment_recommendation)) {
      return {
        ok: false,
        error: `service_demand_map[${i}].investment_recommendation must be string`,
      }
    }
    service_demand_map.push({
      service_or_offering: s.service_or_offering,
      demand_signal: s.demand_signal,
      currently_offered: s.currently_offered as CurrentlyOffered,
      investment_recommendation: s.investment_recommendation,
    })
  }

  // timing_patterns
  const tpRaw = raw.timing_patterns ?? []
  if (!isArray(tpRaw)) {
    return { ok: false, error: 'timing_patterns must be array' }
  }
  const timing_patterns: TimingPattern[] = []
  for (let i = 0; i < tpRaw.length; i++) {
    const t = tpRaw[i]
    if (!isObject(t)) {
      return { ok: false, error: `timing_patterns[${i}] must be object` }
    }
    if (!isString(t.pattern)) {
      return { ok: false, error: `timing_patterns[${i}].pattern must be string` }
    }
    if (!isString(t.evidence_summary)) {
      return {
        ok: false,
        error: `timing_patterns[${i}].evidence_summary must be string`,
      }
    }
    if (!isString(t.actionable_recommendation)) {
      return {
        ok: false,
        error: `timing_patterns[${i}].actionable_recommendation must be string`,
      }
    }
    timing_patterns.push({
      pattern: t.pattern,
      evidence_summary: t.evidence_summary,
      actionable_recommendation: t.actionable_recommendation,
    })
  }

  // refusals
  const refRaw = raw.refusals ?? []
  if (!isArray(refRaw)) {
    return { ok: false, error: 'refusals must be array' }
  }
  const refusals: CohortRefusal[] = []
  for (let i = 0; i < refRaw.length; i++) {
    const r = refRaw[i]
    if (!isObject(r)) {
      return { ok: false, error: `refusals[${i}] must be object` }
    }
    if (!isString(r.field)) {
      return { ok: false, error: `refusals[${i}].field must be string` }
    }
    if (!isString(r.reason)) {
      return { ok: false, error: `refusals[${i}].reason must be string` }
    }
    refusals.push({ field: r.field, reason: r.reason })
  }

  return {
    ok: true,
    rollup: {
      emerging_themes,
      conversion_correlations,
      voice_calibration,
      service_demand_map,
      timing_patterns,
      refusals,
    },
  }
}
