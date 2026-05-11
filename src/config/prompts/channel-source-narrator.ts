/**
 * Bloom House — Wave 25 Channel Source narrator prompt (Sonnet tier).
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (narrator describes pre-computed
 *     story-arc + CAC numbers; never re-imposes a hypothesised direction)
 *   - feedback_self_reported_sources_not_truth.md (Validation segment is
 *     gold — surface it honestly without crediting it back to the channel)
 *   - feedback_deep_fix_vs_bandaid.md (every claim is anchored to a
 *     sample-size annotation; refusal is a first-class output)
 *   - PROMPT-BIAS-AUDIT.md (no number not in the input; v1-contamination
 *     disclosed)
 *
 * What this is
 * ------------
 * The Wedding MBA per-source narrator. Sonnet call. Given one channel
 * snapshot (computeChannelSnapshot result), produces:
 *   - a 4-12 word headline pull-quote
 *   - a story-arc paragraph (Discovery / Inquiry / Validation /
 *     Broadcast / Cross-platform-footprint, all counts cited)
 *   - a CAC reveal paragraph (apparent vs real)
 *   - an optional 1-sentence recommendation (NULL when any cell is thin)
 *   - or a refusal_reason when all data is thin / contamination > 50%
 *
 * Cost: Sonnet, ~$0.03 per source page render. Cached on the snapshot
 * row when persisted.
 */

import type {
  ChannelSnapshot,
  StoryArcCell,
} from '@/lib/services/channel-intel-hub/types'

export const CHANNEL_SOURCE_NARRATOR_PROMPT_VERSION =
  'channel-source-narrator.prompt.v1'

export interface SourceNarratorEvidence {
  question_id: 'channel_source_story_arc'
  question_text: string
  venue_label: string
  channel_display_name: string
  window_days: number
  total_ae: number
  unique_weddings: number
  story_arc: StoryArcCell[]
  apparent_cac_cents: number | null
  real_cac_cents: number | null
  real_cac_strict_cents: number | null
  spend_cents: number
  inquiry_to_booked_rate_0_1: number | null
  avg_review_rating: number | null
  review_count: number
  median_lead_time_days: number | null
  v1_contaminated_pct: number
  data_freshness_iso: string
  min_sample_size: number
}

export interface SourceNarratorOutput {
  headline_pull_quote: string
  story_arc_paragraph: string
  cac_reveal_paragraph: string
  recommendation_if_any: string | null
  refusal_reason: string | null
}

export function buildChannelSourceSystemPrompt(): string {
  return `You are Bloom's Channel Source narrator for the Wedding MBA stage.

Bloom is a forensic identity-reconstruction system for wedding venues.
The Channel Intelligence Hub per-source page answers ONE question:
"What is this channel ACTUALLY doing for this venue?" — using
PRE-COMPUTED forensic numbers.

Your job: given one channel snapshot + a structured block of story-arc
cells (Discovery / Inquiry / Validation / Broadcast / Cross-platform-
footprint), produce a clean narrative for a Wedding MBA presentation
audience.

You are a COMPOSITION engine, not a measurement engine.

## ABSOLUTE RULES (violations = refusal)

1. NEVER cite a number that is not in the input evidence. Not a rounded
   version, not an extrapolation, not a "roughly X".

2. NEVER modify, average, or estimate. The deterministic compute step
   produced the numbers. Your job is to narrate them.

3. Sample-size honesty. If ANY cited cell is below min_sample_size, you
   MUST explicitly say "insufficient sample (n=X)" OR emit a refusal.

4. v1-contamination disclosure. If v1_contaminated_pct > 0, mention the
   asterisk in the narration ("X% of this calculation relied on a
   bias-suspect classifier prompt"). When > 50%, refuse.

5. Story arc discipline. Discovery is a SUBSET of Inquiry. Never say
   "Discovery and Inquiry are different things" — they overlap.
   Validation is NOT a subset (couples found you elsewhere; this channel
   was just the form).
   Cross-platform-footprint is EXPLICITLY excluded from CAC math —
   ALWAYS state this when narrating the segment.

## FORBIDDEN LANGUAGE

NEVER use direction-loaded phrases per Wave 21 doctrine:
  - "Lean toward" / "tip the scale toward"
  - "The data clearly shows" / "this confirms"
  - "Surprisingly" / "unexpectedly"
  - "Should" or "must" outside the recommendation_if_any field

PREFER:
  - "Of the N inquiries that landed via this channel, X actively chose
    this venue (Discovery, n=X). Y came from elsewhere and used this
    channel as the form (Validation, n=Y). Z were auto-distributed by
    the platform's ranker (Broadcast, n=Z, converted at W%)."
  - "Apparent CAC of $X drops to $Y when broadcast and cross-platform
    inquiries are excluded from the denominator."

## OUTPUT SHAPE

Return ONLY this JSON (no markdown, no preamble):

{
  "headline_pull_quote": "4-12 word headline for the page hero.",
  "story_arc_paragraph": "3-5 sentence narration of Discovery / Inquiry / Validation / Broadcast / Cross-platform-footprint. Cite every count.",
  "cac_reveal_paragraph": "2-3 sentence narration of apparent vs real CAC. Cite the spend, the apparent CAC, the real CAC excluding broadcast, and the strict CAC excluding broadcast + cross-platform-footprint.",
  "recommendation_if_any": "1 sentence concrete recommendation OR null.",
  "refusal_reason": "string reason OR null. Mutually exclusive."
}`
}

export function buildChannelSourceUserPrompt(evidence: SourceNarratorEvidence): string {
  const sa = evidence.story_arc
    .map((c) => {
      const tour = c.conversion_to_tour_rate_0_1 !== null
        ? `${(c.conversion_to_tour_rate_0_1 * 100).toFixed(1)}%`
        : 'n/a'
      const book = c.conversion_to_booked_rate_0_1 !== null
        ? `${(c.conversion_to_booked_rate_0_1 * 100).toFixed(1)}%`
        : 'n/a'
      const v1 = c.v1_contaminated_pct > 0 ? ` [v1=${c.v1_contaminated_pct.toFixed(1)}%]` : ''
      return `  - ${c.segment}: n=${c.unique_weddings} unique weddings, tour=${tour}, booked=${book}${v1}\n      annotation: ${c.annotation}`
    })
    .join('\n')

  const fmt$ = (cents: number | null) =>
    cents === null ? 'n/a' : `$${(cents / 100).toFixed(0)}`
  const fmtPct = (r: number | null) =>
    r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`

  const ageHours = computeAgeHours(evidence.data_freshness_iso)

  return `## Question
"${evidence.question_text}"

## Venue
${evidence.venue_label}

## Channel
${evidence.channel_display_name} (window: last ${evidence.window_days} days)

## Top-line counts
  - total attribution events: ${evidence.total_ae}
  - unique weddings touched: ${evidence.unique_weddings}
  - inquiry-to-booked rate (overall): ${fmtPct(evidence.inquiry_to_booked_rate_0_1)}

## Story-arc cells
${sa}

## Cost reveal
  - spend in window: ${fmt$(evidence.spend_cents)}
  - apparent CAC (spend / all booked attributed): ${fmt$(evidence.apparent_cac_cents)}
  - real CAC (excluding broadcast intent): ${fmt$(evidence.real_cac_cents)}
  - strict CAC (excluding broadcast + cross-platform-footprint): ${fmt$(evidence.real_cac_strict_cents)}

## Quality
  - avg review rating: ${evidence.avg_review_rating ?? 'n/a'} (n=${evidence.review_count})
  - median lead time: ${evidence.median_lead_time_days ?? 'n/a'} days

## Calibration
  - min_sample_size threshold: ${evidence.min_sample_size}
  - v1-prompt contamination: ${evidence.v1_contaminated_pct.toFixed(1)}%
  - data freshness: ${ageHours.toFixed(1)}h ago

Narrate this for a Wedding MBA audience. Compose ONLY the numbers above.
Refuse if total_ae < ${evidence.min_sample_size} OR v1-contamination > 50%.`
}

function computeAgeHours(iso: string): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return (Date.now() - t) / (1000 * 60 * 60)
}

export interface ValidateResult {
  ok: boolean
  output?: SourceNarratorOutput
  error?: string
}

export function validateChannelSourceNarratorOutput(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'output is not an object' }
  }
  const o = raw as Record<string, unknown>
  const headline = typeof o.headline_pull_quote === 'string' ? o.headline_pull_quote : ''
  const storyArc = typeof o.story_arc_paragraph === 'string' ? o.story_arc_paragraph : ''
  const cacReveal = typeof o.cac_reveal_paragraph === 'string' ? o.cac_reveal_paragraph : ''
  const rec =
    typeof o.recommendation_if_any === 'string'
      ? o.recommendation_if_any
      : o.recommendation_if_any === null
        ? null
        : null
  const refusal =
    typeof o.refusal_reason === 'string'
      ? o.refusal_reason
      : o.refusal_reason === null
        ? null
        : null

  if (refusal && refusal.trim().length > 0) {
    return {
      ok: true,
      output: {
        headline_pull_quote: '',
        story_arc_paragraph: '',
        cac_reveal_paragraph: '',
        recommendation_if_any: null,
        refusal_reason: refusal,
      },
    }
  }
  if (headline.trim().length === 0 || storyArc.trim().length === 0) {
    return {
      ok: false,
      error: 'headline_pull_quote and story_arc_paragraph are required when not refusing',
    }
  }
  return {
    ok: true,
    output: {
      headline_pull_quote: headline,
      story_arc_paragraph: storyArc,
      cac_reveal_paragraph: cacReveal,
      recommendation_if_any: rec,
      refusal_reason: null,
    },
  }
}

/** Default question text used in evidence assembly. */
export function defaultSourceQuestionText(channelDisplayName: string): string {
  return `What is ${channelDisplayName} actually doing for this venue?`
}

/** Wave 25 reconciliation: ChannelSnapshot → narrator evidence. */
export function buildSourceNarratorEvidence(args: {
  snapshot: ChannelSnapshot
  venueLabel: string
}): SourceNarratorEvidence {
  const { snapshot, venueLabel } = args
  return {
    question_id: 'channel_source_story_arc',
    question_text: defaultSourceQuestionText(snapshot.display_name),
    venue_label: venueLabel,
    channel_display_name: snapshot.display_name,
    window_days: snapshot.window_days,
    total_ae: snapshot.sample_sizes.ae_total,
    unique_weddings: snapshot.sample_sizes.unique_weddings,
    story_arc: snapshot.story_arc,
    apparent_cac_cents: snapshot.cost_metrics.cac_cents,
    real_cac_cents: snapshot.cost_metrics.cac_excluding_broadcast_cents,
    real_cac_strict_cents:
      snapshot.cost_metrics.cac_excluding_broadcast_and_crossplatform_cents,
    spend_cents: snapshot.cost_metrics.spend_cents,
    inquiry_to_booked_rate_0_1: snapshot.funnel.inquiry_to_booked_rate_0_1,
    avg_review_rating: snapshot.quality_metrics.avg_review_rating,
    review_count: snapshot.quality_metrics.review_count,
    median_lead_time_days: snapshot.quality_metrics.median_lead_time_days,
    v1_contaminated_pct:
      snapshot.sample_sizes.ae_total > 0
        ? (snapshot.confidence_signals.v1_contaminated_count /
            snapshot.sample_sizes.ae_total) *
          100
        : 0,
    data_freshness_iso: snapshot.confidence_signals.data_freshness_iso,
    min_sample_size: 10,
  }
}
