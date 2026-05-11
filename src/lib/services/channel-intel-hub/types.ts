/**
 * Bloom House — Wave 25 Channel Intelligence Hub shared types.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (every story-arc segment + every
 *     cost number carries sample size + prompt-version disclosure)
 *   - feedback_self_reported_sources_not_truth.md (per-source rollup
 *     exposes Discovery / Validation / Broadcast forensic splits)
 *   - feedback_deep_fix_vs_bandaid.md (presentation export embeds the
 *     full calibration band on every page — airtightness is part of the
 *     primitive, not bolted on)
 *
 * The hub has two surfaces:
 *   - /intel/channels — comparison page; one card per source
 *   - /intel/channels/[channel_slug] — per-source deep dive
 *
 * Both surfaces read ChannelSnapshot — the deterministic, denormalised
 * result of computeChannelSnapshot().
 */

/** URL-safe kebab-case channel slug — powers the dynamic route. */
export type ChannelSlug = string

/** The forensic role from Wave 7B. */
export type ForensicRole = 'acquisition' | 'validation' | 'conversion' | 'mixed' | 'unknown'

/** The forensic intent from Wave 16. */
export type ForensicIntent = 'targeted' | 'broadcast' | 'validation' | 'unknown'

/** The Wedding MBA story-arc segments. */
export type StoryArcSegment =
  | 'discovery'
  | 'inquiry'
  | 'validation'
  | 'broadcast'
  | 'cross_platform_footprint'

export interface RoleBreakdown {
  acquisition: number
  validation: number
  conversion: number
  mixed: number
  unknown: number
}

export interface IntentBreakdown {
  targeted: number
  broadcast: number
  validation: number
  unknown: number
}

export interface FunnelBreakdown {
  inquiries: number
  tours: number
  booked: number
  inquiry_to_tour_rate_0_1: number | null
  tour_to_booked_rate_0_1: number | null
  inquiry_to_booked_rate_0_1: number | null
  drop_inquiry_to_tour_0_1: number | null
  drop_tour_to_booked_0_1: number | null
}

export interface CostMetrics {
  /** Total spend recorded against this channel within the window. */
  spend_cents: number
  /** Apparent CAC = spend / all booked weddings attributed. */
  cac_cents: number | null
  /** Real CAC = spend / booked weddings excluding broadcast intent. */
  cac_excluding_broadcast_cents: number | null
  /**
   * Even stricter: exclude broadcast AND nurture/cross-platform-footprint
   * rows. The denominator is only Discovery + Validation booked. This
   * is the headline reveal for the Wedding MBA talk.
   */
  cac_excluding_broadcast_and_crossplatform_cents: number | null
  cost_per_inquiry_cents: number | null
  cost_per_tour_cents: number | null
}

export interface QualityMetrics {
  avg_booking_value_cents: number | null
  median_lead_time_days: number | null
  avg_review_rating: number | null
  review_count: number
  /** Persona label → count. Loose-matched per Wave 5A/15. */
  persona_distribution: Record<string, number>
}

export interface SampleSizes {
  unique_weddings: number
  ae_total: number
  weddings_per_role: RoleBreakdown
  weddings_per_intent: IntentBreakdown
  weddings_per_story_arc: Record<StoryArcSegment, number>
}

export interface ConfidenceSignals {
  v1_contaminated_count: number
  v2_classified_count: number
  null_classified_count: number
  data_freshness_iso: string
  prompt_versions_used: string[]
  window_days: number
  computed_with_function: string
}

/** One story-arc segment with conversion numbers. */
export interface StoryArcCell {
  segment: StoryArcSegment
  unique_weddings: number
  booked_weddings: number
  tour_weddings: number
  conversion_to_tour_rate_0_1: number | null
  conversion_to_booked_rate_0_1: number | null
  avg_booking_value_cents: number | null
  /** Up to 20 sample wedding-ids for the evidence drill-down. */
  sample_wedding_ids: string[]
  /** Prompt versions seen across the contributing AE rows. */
  prompt_versions_used: string[]
  /** v1-contamination pct across the underlying rows. */
  v1_contaminated_pct: number
  /** A short annotation explaining how this segment is defined. */
  annotation: string
}

export interface ChannelSnapshot {
  venue_id: string
  channel_slug: ChannelSlug
  source_platform: string
  display_name: string
  computed_at_iso: string
  window_days: number
  role_breakdown: RoleBreakdown
  intent_breakdown: IntentBreakdown
  funnel: FunnelBreakdown
  cost_metrics: CostMetrics
  quality_metrics: QualityMetrics
  sample_sizes: SampleSizes
  confidence_signals: ConfidenceSignals
  /** The five story-arc cells, in order. */
  story_arc: StoryArcCell[]
  /** Disagreement findings (Wave 17) tied to this channel. */
  disagreement_findings_count: number
}

export interface ChannelComparisonRow {
  channel_slug: ChannelSlug
  source_platform: string
  display_name: string
  unique_weddings: number
  ae_total: number
  story_arc_mini: Record<StoryArcSegment, number>
  funnel_inquiries: number
  funnel_booked: number
  conversion_rate_0_1: number | null
  apparent_cac_cents: number | null
  real_cac_cents: number | null
  cac_delta_cents: number | null
  avg_review_rating: number | null
  review_count: number
  data_freshness_iso: string
  v1_contaminated_pct: number
}

export interface ChannelComparisonPayload {
  ok: boolean
  venue_id: string
  venue_label: string
  window_days: number
  computed_at_iso: string
  rows: ChannelComparisonRow[]
  total_channels_with_data: number
  error?: string
}

export interface PerSourcePayload {
  ok: boolean
  venue_id: string
  venue_label: string
  channel_slug: ChannelSlug
  snapshot: ChannelSnapshot | null
  /** Sonnet narrator output (per-source story arc paragraphs). */
  narrator: NarrationResult | null
  /** Disagreement findings count for this channel (Wave 17). */
  disagreements: Array<{
    id: string
    axis: string
    magnitude_score: number | null
    stated_value: unknown
    forensic_value: unknown
    last_observed_at: string | null
  }>
  error?: string
}

/** The result of the Sonnet narrator. */
export interface NarrationResult {
  /** A short headline pull-quote (4-12 words). */
  headline_pull_quote: string
  /** The story-arc paragraphs (one per segment, or a combined narrative). */
  story_arc_paragraph: string
  /** The forensic CAC reveal paragraph. */
  cac_reveal_paragraph: string
  /** Optional 1-sentence recommendation. NULL when data is thin. */
  recommendation_if_any: string | null
  /** Refusal — mutually exclusive with the other fields. */
  refusal_reason: string | null
  /** Prompt version used. */
  prompt_version: string
}
