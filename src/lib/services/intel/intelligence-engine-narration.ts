/**
 * Intelligence-Engine LLM Narration Layer
 *
 * AI-VS-TEMPLATED-AUDIT.md finding #1 (2026-05-09). The 14 detectors in
 * `intelligence-engine.ts` ship rows under the "AI-generated insights"
 * label on /intel/dashboard + /intel/insights, but every body / title /
 * action is a string-template fill. Coordinators cannot tell those rows
 * apart from the real LLM-narrated rows produced by `risk-flags.ts`,
 * `heat-narration.ts`, `cohort-match.ts`, and `correlation-narration.ts`.
 *
 * Per Isadora directive (2026-05-09): switch to all-LLM narration until
 * cost-optimisation matters. The deterministic detector still does the
 * math (which day converts best, which source has the highest
 * conversion, etc.) — that part is cheap and stays. Then EACH detector
 * candidate is handed to this narrator, which calls Sonnet to compose
 * coordinator-facing title + body + action.
 *
 * Pattern mirrors `correlation-narration.ts`:
 *   1. Detector emits structured facts (numbers, labels, sample sizes).
 *   2. LLM narrator turns facts into 2-3 sentences of prose.
 *   3. Numbers-guard validates output (no fabricated numbers).
 *   4. Falls back to deterministic template when:
 *        - cost-ceiling gate closes
 *        - LLM call fails / parses badly
 *        - numbers-guard rejects the narration
 *
 * Each row's persistence layer records `narration_source = 'llm' |
 * 'template'` (migration 251) so a future UI badge can distinguish.
 *
 * The 14 detectors were grouped into 9 shape-families. One narrator
 * dispatches by family — same Sonnet call, different framing block.
 */

import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { checkNarrationNumbers } from '@/lib/services/insights/numbers-guard'
import { buildCoordinatorPrompt } from '@/lib/ai/coordinator-prompt'
import type { ClassicalEvidence, InsightNarration } from '@/lib/services/insights/types'

// 2026-05-09 LLM-CALL-INVENTORY personality drift #3: bumped to v2.0
// when migrated to the canonical coordinator-prompt assembler.
//
// 2026-05-09 Wave 1C — emotional themes: bumped to v2.1 when the
// emotional_theme_pulse family landed. The detector reads
// `aggregateAutoContextThemes` and surfaces wedding-industry-relevant
// theme uptakes; the narrator validates counts against the per-family
// allowlist (numbers-guard) and treats sensitive-tagged categories as
// counts only — never names couples alongside sensitive themes.
export const BRAIN_INTEL_ENGINE_PROMPT_VERSION =
  'intelligence-engine-narration.v2.1'

/** All 9 shape-families the 14 detectors fall into. Each family's
 *  framing block lives in `framingFor()` below. */
export type IntelInsightFamily =
  /** Two cohorts compared on a conversion / win rate ("Tuesday tours
   *  convert at 42% vs 18% on Sundays"). */
  | 'conversion_comparison'
  /** Activity volume between buckets ("Mondays generate 30 inquiries vs
   *  6 on Sundays"). */
  | 'volume_comparison'
  /** Source quality tradeoffs (vol vs conversion vs cycle time). */
  | 'source_quality'
  /** Concentration-style ("X% of lost deals cite Y", "X% of Z source
   *  leads are lost"). */
  | 'concentration_pattern'
  /** Pipeline / readiness / count-with-revenue-at-risk ("N leads
   *  stalled for 14+ days", "N guests missing dietary info"). */
  | 'count_with_risk'
  /** Capacity / seasonal slot fill ("April is 80% booked with 5 months
   *  to go" / "March has zero bookings — 3 months away"). */
  | 'capacity_signal'
  /** Per-couple readiness / engagement composite ("Couple X is
   *  behind average / score N/100"). */
  | 'per_couple_score'
  /** Vendor or coordinator outlier ("Vendor X rated 2.3/5 across N
   *  events", "Coordinator Y converts 42% vs 18%"). */
  | 'entity_outlier'
  /** Repeated operational pattern ("Last 3 weddings had delays in
   *  reception_setup phase"). */
  | 'operational_pattern'
  /** Wave 1C — venue-aggregate emotional theme pulse. Reports a
   *  category of soft-context observation (cultural ceremony asks,
   *  vendor preferences, dietary mentions) trending across multiple
   *  couples. Sensitive-tagged categories (health, grief, etc.) are
   *  counts-only; couples are never named. */
  | 'emotional_theme_pulse'

/** Structured numeric facts the narrator passes to the LLM, plus the
 *  template the detector already composed (used as the fallback prose
 *  when narration fails). The narrator returns either a fresh LLM
 *  narration with numbers-guard cleared, or the original template
 *  unchanged. */
export interface NarratorFacts {
  family: IntelInsightFamily
  /** Plain-English description of what was detected. The LLM gets this
   *  as the "what" prefix. Should NOT contain numbers — those go in
   *  `numbers` so the guard can validate against them. */
  framing: string
  /** Numeric tokens the LLM is allowed to reference. Mirrors
   *  ClassicalEvidence.numbers — passed straight to the numbers-guard.
   *  Include integer + percent + dollar variants the prose might use. */
  numbers: Array<number | string>
  /** Optional category hint surfaced to the LLM ("response_time",
   *  "lead_conversion", etc.). Lifted from the detector's category. */
  category?: string
  /** Original detector-composed template title/body/action. When the
   *  narrator fails or the gate closes, this is what surfaces. */
  fallback: {
    title: string
    body: string
    action: string | null
  }
}

interface NarrateOptions {
  venueId: string
  facts: NarratorFacts
}

interface NarrateResult {
  narration: InsightNarration
  source: 'llm' | 'template'
}

const TITLE_MAX_CHARS = 90
const MAX_OUTPUT_TOKENS = 320

/**
 * Family-specific framing block. Each family tells the narrator what
 * SHAPE the comparison is so the prose lands in coordinator voice
 * without inventing structure. Generic enough that one Sonnet call
 * with `family` switching handles all 9 patterns.
 */
function framingFor(family: IntelInsightFamily): string {
  switch (family) {
    case 'conversion_comparison':
      return [
        'This insight compares the conversion / win rate of two cohorts.',
        'Frame it as "X converts at Y% vs Z%" without claiming causation.',
        'Action: one specific operational change to lean into the higher-converting cohort.',
      ].join(' ')
    case 'volume_comparison':
      return [
        'This insight compares activity VOLUME between buckets (peak day, peak hour).',
        'Frame it as "the busiest <bucket> has <N> events vs <N> on the quietest".',
        'Action: a staffing or marketing-timing recommendation.',
      ].join(' ')
    case 'source_quality':
      return [
        'This insight compares lead sources on quality (conversion + booking value + cycle time), not just volume.',
        'Highlight when the highest-volume source is NOT the highest-quality one, or the fastest-cycling source.',
        'Action: a marketing-mix or funnel-improvement recommendation.',
      ].join(' ')
    case 'concentration_pattern':
      return [
        'This insight reports a concentration pattern: a single category accounts for an outsized share of an outcome (lost-deal reasons, lost-by-source rates).',
        'Frame the share as "X of N" / "X%" and explain why concentration matters.',
        'Action: a fix targeted at the dominant cause.',
      ].join(' ')
    case 'count_with_risk':
      return [
        'This insight reports a count of items in an at-risk state (pipeline stalls, guests missing dietary info, severe allergies without care notes).',
        'Frame the urgency in terms of operational risk, not certainty of loss.',
        'Action: a concrete this-week intervention for the count.',
      ].join(' ')
    case 'capacity_signal':
      return [
        'This insight reports a calendar / capacity signal — a month filling fast, or a month that is empty too far out.',
        'Frame it factually with months remaining and current fill state.',
        'Action: scarcity messaging, a promotion, or a pricing adjustment as appropriate.',
      ].join(' ')
    case 'per_couple_score':
      return [
        'This insight is per-couple. It scores ONE couple against a venue baseline (planning readiness, review likelihood).',
        'Use the couple name when given. Frame the score relative to the baseline.',
        'Action: a coordinator check-in or a personalised outreach step for THAT couple.',
      ].join(' ')
    case 'entity_outlier':
      return [
        'This insight flags an outlier entity — a coordinator, a vendor, or a partner — performing significantly better or worse than peers on a measurable metric.',
        'Frame the comparison as a delta with sample size context.',
        'Action: a process / coaching / partnership step targeted at the outlier.',
      ].join(' ')
    case 'operational_pattern':
      return [
        'This insight reports a repeated operational pattern across recent events (timeline delay phases, day-of friction modes).',
        'Frame it as a recurring pattern, not a one-off.',
        'Action: a process or template change that addresses the root cause.',
      ].join(' ')
    case 'emotional_theme_pulse':
      return [
        'This insight reports a wedding-industry-relevant theme that has trended across multiple couples this period (cultural ceremony asks, vendor preferences, multi-cultural blends, dietary diversity).',
        'Frame the count and the trend ("8 couples this month vs 2 last month").',
        'When the framing notes the theme is sensitive (health, grief, financial stress, family conflict), report counts only and NEVER name a couple. Treat it as an audience signal, not a per-couple disclosure.',
        'Action: a venue-level positioning, vendor-mix, or messaging change that meets the trending need.',
      ].join(' ')
  }
}

const TASK_INSTRUCTIONS = `Narrate a venue-intelligence insight. The insight has already been computed deterministically; your job is to translate the structured facts into 2-3 sentences of plain English in coordinator voice.

Output JSON with three keys:
  - title: short headline, max ${TITLE_MAX_CHARS} chars. Reference the
    pattern in plain English. Do not include statistical jargon
    (r-values, p-values, "Pearson", "n=", etc.). Quoting one or two
    of the listed numbers is encouraged when it sharpens the headline.
  - body: 2-3 plain-English sentences. Ground every claim in the
    LISTED NUMBERS block; never invent new percentages, ratios, or
    dollar amounts. Coordinator-readable, not engineer-readable.
  - action: ONE specific operational thing the coordinator should
    do this week. Concrete and limited to the venue's own actions.
    Set to null only if the framing genuinely calls for no action.

CRITICAL RULES:
- Never claim causation. Use "tracks with", "tends to", "is
  associated with", "preceded", not "caused".
- Never quote a couple's email or message text. Reference the shape
  of behaviour, not the content.`

/**
 * Run the narrator. On success returns the LLM-composed narration +
 * source='llm'. On any failure (gate closed, LLM error, parse error,
 * numbers-guard rejection) returns the detector's fallback narration
 * unchanged + source='template'.
 */
export async function narrateIntelligenceInsight(
  options: NarrateOptions,
): Promise<NarrateResult> {
  const { venueId, facts } = options

  const fallbackNarration: InsightNarration = {
    title: facts.fallback.title,
    body: facts.fallback.body,
    action: facts.fallback.action,
  }

  // Cost-ceiling gate — when the venue is paused, skip the LLM and
  // surface the deterministic template. Same contract every other
  // narrator (heat-narration, risk-flags, correlation-narration) honours.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    return { narration: fallbackNarration, source: 'template' }
  }

  const userPrompt = [
    `INSIGHT FAMILY: ${facts.family}`,
    facts.category ? `CATEGORY: ${facts.category}` : '',
    '',
    'FRAMING (what the detector found):',
    facts.framing,
    '',
    'LISTED NUMBERS (the only numeric tokens you may use):',
    facts.numbers.length > 0
      ? facts.numbers.map((n) => `  - ${String(n)}`).join('\n')
      : '  (no numeric tokens — narrate qualitatively)',
    '',
    'FRAMING GUIDANCE:',
    framingFor(facts.family),
    '',
    'Compose the JSON narration now.',
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')

  const { systemPrompt, promptVersion, contentTier } = await buildCoordinatorPrompt({
    venueId,
    surface: 'narration_intelligence_engine',
    taskInstructions: TASK_INSTRUCTIONS,
    numbersGuard: Object.fromEntries(
      facts.numbers.map((n, i) => [`allowed_${i}`, n]),
    ),
  })

  let parsed: Partial<InsightNarration> | null = null
  try {
    parsed = await callAIJson<Partial<InsightNarration>>({
      systemPrompt,
      userPrompt,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4,
      venueId,
      taskType: 'intelligence_engine_narration',
      tier: 'sonnet',
      promptVersion,
      contentTier,
    })
  } catch (err) {
    console.warn(
      '[intel-engine-narration] LLM call failed; surfacing template fallback:',
      redactError(err),
    )
    return { narration: fallbackNarration, source: 'template' }
  }

  if (!parsed || typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
    return { narration: fallbackNarration, source: 'template' }
  }

  const title = parsed.title.trim().slice(0, TITLE_MAX_CHARS)
  const body = parsed.body.trim()
  const action =
    typeof parsed.action === 'string' && parsed.action.trim().length > 0
      ? parsed.action.trim()
      : null

  // Numbers-guard — assert the LLM didn't fabricate numbers. Run
  // against the same allowlist the detector built. Tolerate confidence
  // claims is `false` by default — these detectors don't surface
  // explicit confidence numbers in the narration.
  const classical: ClassicalEvidence = {
    cacheKey: '',
    numbers: facts.numbers,
    payload: {},
    sampleSize: 0,
  }

  const titleViolations = checkNarrationNumbers(title, classical)
  const bodyViolations = checkNarrationNumbers(body, classical)
  const actionViolations = action
    ? checkNarrationNumbers(action, classical)
    : []

  const violations = [...titleViolations, ...bodyViolations, ...actionViolations]
  if (violations.length > 0) {
    console.warn(
      `[intel-engine-narration] numbers-guard rejected ${facts.family} narration; surfacing template:`,
      violations.map((v) => v.token).join(', '),
    )
    return { narration: fallbackNarration, source: 'template' }
  }

  // Em dash sweep — the system prompt forbids them but a single slip
  // shouldn't reject the whole narration. Replace with comma + space.
  // No em dashes per Isadora style guide.
  const cleanedTitle = title.replace(/\s*[—–]\s*/g, ', ')
  const cleanedBody = body.replace(/\s*[—–]\s*/g, ', ')
  const cleanedAction = action
    ? action.replace(/\s*[—–]\s*/g, ', ')
    : null

  return {
    narration: {
      title: cleanedTitle,
      body: cleanedBody,
      action: cleanedAction,
    },
    source: 'llm',
  }
}

/**
 * Re-export the model + prompt-version used so the runner can stamp
 * llm_model_used + prompt_version_used onto the persisted row. Mirrors
 * the pattern used by every other LLM-narrating insight surface.
 */
export const INTEL_ENGINE_NARRATION_MODEL = CLAUDE_MODEL
