/**
 * Bloom House: Canonical coordinator-prompt assembler.
 *
 * Single entry point every coordinator-facing narrator goes through to
 * compose its system prompt. Replaces the 24 ad-hoc system prompts the
 * LLM-CALL-INVENTORY surfaced (10 named-Sage / 10 nameless / 1
 * named-venue) with one canonical 4-layer stack:
 *
 *   UNIVERSAL_RULES + COORDINATOR_RULES + buildPersonalityPrompt(...) + numbersGuardBlock + taskBlock
 *
 * The aiName, voice dials, banned phrases, USPs, and voice-prefs come
 * from `loadCoordinatorPersonalityData(venueId)` — the same per-venue
 * personality the couple-facing brains use, so the coordinator and
 * couple sides finally hear the same character.
 *
 * The assembler also stamps a `promptVersion` per surface so api_costs
 * + downstream audits can correlate cost / latency / quality to a
 * specific surface revision. Bumps land in PROMPTS-CHANGELOG.md.
 */

import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { COORDINATOR_RULES } from '@/config/prompts/coordinator-rules'
import { buildPersonalityPrompt } from '@/lib/ai/personality-builder'
import { loadCoordinatorPersonalityData } from '@/lib/ai/personality-loader'

/**
 * Surface enum. One entry per coordinator-facing narrator. Adding a
 * new surface MUST land here so the prompt-version bump goes through
 * a typed contract — no ad-hoc strings.
 */
export type CoordinatorSurface =
  | 'briefing_weekly'
  | 'briefing_monthly'
  | 'daily_digest'
  | 'weekly_digest'
  | 'narration_correlation'
  | 'narration_heat'
  | 'narration_cohort'
  | 'narration_decay'
  | 'narration_risk'
  | 'narration_pricing'
  | 'narration_source_mix'
  | 'narration_strength'
  | 'narration_override'
  | 'narration_intelligence_engine'
  | 'narration_weather'
  | 'narration_anomaly_metric'
  | 'narration_anomaly_availability'
  | 'narration_weekly_learned'
  | 'narration_attendee_intel'
  | 'journey_narrative'
  | 'cultural_moments_propose'
  | 'nlq_intel'
  | 'post_tour_brief'
  | 'reengagement_drafter'

export interface CoordinatorPromptContext {
  venueId: string
  surface: CoordinatorSurface
  /**
   * Surface-specific instructions, JSON contract, examples — the part
   * that varies per narrator. The assembler appends this verbatim
   * after personality + numbers-guard so the per-surface authoring
   * stays unchanged and only the IDENTITY layers unify.
   */
  taskInstructions: string
  /**
   * Numeric facts the LLM is allowed to reference. Rendered as a
   * NUMBERS YOU MAY USE block the COORDINATOR_RULES enforces against.
   * Pass the same allowlist the surface's numbers-guard checks against
   * post-generation; redundant by design — guard is the safety net,
   * prompt is the prevention.
   */
  numbersGuard?: Record<string, number | string | null | undefined>
  /**
   * Sensitivity tier of the inputs (Playbook 21.3.1):
   *   1 = couple PII paragraphs (heat narration, decay narration,
   *       risk flags, journey narrative, post-tour brief).
   *   2 = venue-aggregate (briefings, digests, /intel narrations).
   * Default 2; callers handling per-couple paragraphs MUST pass 1.
   */
  contentTier?: 1 | 2
}

export interface BuiltCoordinatorPrompt {
  systemPrompt: string
  promptVersion: string
  contentTier: 1 | 2
}

/**
 * Per-surface prompt-version stamp. Bump the trailing minor when this
 * assembler's structure changes in a way that could move output
 * quality / cost / latency on the surface. Bumps belong in
 * PROMPTS-CHANGELOG.md; the version is logged to api_costs.prompt_version
 * by every callAI invocation that threads it through.
 *
 * The leading-major component aligns with the pre-unification version
 * each surface carried in the LLM-CALL-INVENTORY snapshot, so a
 * post-migration cost-rollup can still correlate by surface name.
 */
const PROMPT_VERSIONS: Record<CoordinatorSurface, string> = {
  briefing_weekly: 'briefings.prompt.v2.0',
  briefing_monthly: 'briefings.monthly.v2.0',
  daily_digest: 'daily-digest.prompt.v2.0',
  weekly_digest: 'weekly-digest.prompt.v2.0',
  narration_correlation: 'correlation-narration.prompt.v2.0',
  narration_heat: 'heat-narration.prompt.v2.0',
  narration_cohort: 'cohort-match.prompt.v2.0',
  narration_decay: 'decay-re-engagement.prompt.v2.0',
  narration_risk: 'risk-flags.prompt.v2.0',
  narration_pricing: 'pricing-elasticity.prompt.v2.0',
  narration_source_mix: 'source-mix-counterfactual.prompt.v2.0',
  narration_strength: 'strength-area-cohort.prompt.v2.0',
  narration_override: 'coordinator-override-pattern.prompt.v2.0',
  narration_intelligence_engine: 'intelligence-engine-narration.v2.0',
  narration_weather: 'weather-cancellation-narration.prompt.v2.0',
  narration_anomaly_metric: 'anomaly-detection.prompt.v2.0',
  narration_anomaly_availability: 'availability-anomaly-explanation.prompt.v2.0',
  narration_weekly_learned: 'weekly-learned.v2.0',
  narration_attendee_intel: 'attendee-intel.v2.0',
  journey_narrative: 'journey-narrative.prompt.v2.0',
  cultural_moments_propose: 'cultural-moments-llm-propose.v2.0',
  nlq_intel: 'intel-brain.prompt.v2.0',
  post_tour_brief: 'post-tour-brief.prompt.v2.0',
  reengagement_drafter: 're-engagement-drafter.prompt.v2.0',
}

/**
 * Default content tier per surface. Surfaces handling per-couple
 * paragraphs default to tier 1; venue-aggregate dashboards default to
 * tier 2. Callers may override via `contentTier` when their input shape
 * differs from the default (e.g. a venue-aggregate journey narrative
 * over public touchpoints).
 */
const DEFAULT_CONTENT_TIER: Record<CoordinatorSurface, 1 | 2> = {
  briefing_weekly: 2,
  briefing_monthly: 2,
  daily_digest: 2,
  weekly_digest: 2,
  narration_correlation: 2,
  narration_heat: 1,
  narration_cohort: 1,
  narration_decay: 1,
  narration_risk: 1,
  narration_pricing: 2,
  narration_source_mix: 2,
  narration_strength: 2,
  narration_override: 2,
  narration_intelligence_engine: 2,
  narration_weather: 2,
  narration_anomaly_metric: 2,
  narration_anomaly_availability: 2,
  narration_weekly_learned: 2,
  narration_attendee_intel: 2,
  journey_narrative: 1,
  cultural_moments_propose: 2,
  nlq_intel: 2,
  post_tour_brief: 1,
  reengagement_drafter: 1,
}

function renderNumbersGuardBlock(
  numbers: CoordinatorPromptContext['numbersGuard'],
): string {
  if (!numbers) return ''
  const entries = Object.entries(numbers).filter(
    ([, v]) => v !== undefined && v !== null && String(v).length > 0,
  )
  if (entries.length === 0) return ''
  const lines = entries.map(([k, v]) => `  - ${k}: ${String(v)}`)
  return `\n\n## NUMBERS YOU MAY USE\n\nThese are the only numbers you may reference. Anything not listed here is unknown to you; do not invent values, do not compute new ratios from them beyond what is already provided.\n\n${lines.join('\n')}`
}

/**
 * Resolve the per-surface prompt-version stamp without requiring the
 * caller to load the full assembler. Useful for cache-key plumbing
 * (`withAiCache`) and post-fix fallback paths that need the stamp on
 * api_costs even when the assembler call short-circuits.
 */
export function coordinatorPromptVersion(surface: CoordinatorSurface): string {
  return PROMPT_VERSIONS[surface]
}

/**
 * Build the canonical coordinator system prompt for `surface`.
 *
 * Order:
 *   1. UNIVERSAL_RULES — cross-product hard rules (AI transparency,
 *      anti-hallucination, banned phrases). Same scaffolding the
 *      couple-facing brains use.
 *   2. COORDINATOR_RULES — addressee = teammate, numbers discipline,
 *      no absolute-certainty phrases, output shape, no em dashes.
 *   3. Personality prompt — venue-specific aiName, voice dials, USPs,
 *      banned/approved phrases, signoff block. Same builder the
 *      couple-side stack uses.
 *   4. Numbers-guard block — when provided, the explicit allowlist
 *      the COORDINATOR_RULES line about numbers references.
 *   5. Task block — surface-specific instructions + JSON contract.
 */
export async function buildCoordinatorPrompt(
  ctx: CoordinatorPromptContext,
): Promise<BuiltCoordinatorPrompt> {
  const personalityData = await loadCoordinatorPersonalityData(ctx.venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)
  const numbersGuardBlock = renderNumbersGuardBlock(ctx.numbersGuard)
  const taskBlock = `\n\n## YOUR TASK\n\n${ctx.taskInstructions.trim()}`

  const systemPrompt = [
    UNIVERSAL_RULES,
    COORDINATOR_RULES,
    personalityPrompt,
    numbersGuardBlock,
    taskBlock,
  ]
    .filter((block) => block && block.trim().length > 0)
    .join('\n\n')

  return {
    systemPrompt,
    promptVersion: PROMPT_VERSIONS[ctx.surface],
    contentTier: ctx.contentTier ?? DEFAULT_CONTENT_TIER[ctx.surface],
  }
}
