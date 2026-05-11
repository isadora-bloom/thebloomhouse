/**
 * Bloom House — Wave 24 Channel Truth shared types.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (every cell carries sample size +
 *     prompt-version disclosure + freshness)
 *   - feedback_deep_fix_vs_bandaid.md (this is the lead-with-grade
 *     evidence surface)
 *
 * Each pre-built question's compute() function returns a ComputedAnswer.
 * The page hydrates a list of these and the narrator turns each into
 * prose.
 */

import type { NarratorOutput } from '@/config/prompts/channel-truth-narrator'

/** Confidence-level pill rendered on every answer card. */
export type ConfidenceLevel = 'high' | 'moderate' | 'thin'

/**
 * The catalog of pre-built questions. Adding a new question = adding a
 * compute function under answer/ + registering it here + extending the
 * narrator evidence cells. The narrator prompt does NOT have to change.
 */
export type ChannelTruthQuestionId =
  | 'knot_targeted_vs_broadcast_conversion'
  | 'knot_real_cac_excluding_broadcast'
  | 'knot_apparent_vs_real_breakdown'
  | 'stated_vs_forensic_channel_mix'
  | 'ai_tool_cohort_difference'
  | 'similar_platforms_distorting_cac'
  | 'recent_month_vs_trailing_average'

/** Static metadata about each question. */
export interface ChannelTruthQuestionMeta {
  id: ChannelTruthQuestionId
  question_text: string
  /** What the deterministic compute function is named (for audit footer). */
  compute_signature: string
  /** Default min sample-size threshold per cell. */
  default_min_sample_size: number
}

/** One evidence row in the drill-down. */
export interface EvidenceWedding {
  wedding_id: string
  /** Human-friendly identifier (event_code or fallback). */
  display_label: string
  /** Free-text annotation explaining why this wedding is in the cell. */
  annotation: string
  /** Source platform observed. */
  source_platform: string | null
  /** Intent class on the attribution event(s). */
  intent_class: string | null
  /** Forensic role classification. */
  role: string | null
  /** Whether any AE row tied to this wedding is v1-classified. */
  v1_contaminated: boolean
}

/**
 * The structured result of one deterministic compute. The narrator
 * reads this; the page also renders the evidence chain + reproducibility
 * footer directly from it.
 */
export interface ComputedAnswer {
  question_id: ChannelTruthQuestionId
  question_text: string
  /**
   * The deterministic compute function name (e.g.
   * "answerKnotTargetedVsBroadcastConversion"). Rendered in the
   * reproducibility footer so external readers can locate the source.
   */
  compute_signature: string
  /** ISO timestamp the compute ran. */
  computed_at_iso: string
  /**
   * The cells the narrator consumes. Each cell has its own sample
   * size + headline value + CI + contamination pct.
   */
  cells: ComputedCell[]
  /** Total sample size (sum or max across cells, question-dependent). */
  total_sample_size: number
  /** Confidence-level pill for the card. */
  confidence_level: ConfidenceLevel
  /** Cells below this threshold mean the answer should refuse / hedge. */
  min_sample_size: number
  /** % of cells' rows that were classified under a v1-suspect prompt. */
  v1_contamination_pct: number
  /** ISO timestamp of the most-recently-classified data point. */
  data_freshness_iso: string
  /** Up to 50 underlying weddings for the drill-down. */
  evidence_weddings: EvidenceWedding[]
  /** Question-level context the narrator may use (e.g. "8 channels"). */
  context_notes: string[]
  /**
   * Whether the deterministic side decided to refuse on its own (e.g.
   * the question's required data simply isn't there — like "AI cohort
   * difference" with no ai_tool discovery_sources rows). When this is
   * true, the narrator is BYPASSED and a stub refusal is shown.
   */
  hard_refusal: { refused: true; reason: string } | null
  /** Prompt versions present in the underlying rows (audit trail). */
  prompt_versions_used: string[]
}

export interface ComputedCell {
  label: string
  n: number
  headline_value: unknown
  ci_95_half_width: number | null
  v1_contaminated_pct: number
  /** Wedding-ids that contributed to this cell (capped at 50). */
  contributing_wedding_ids: string[]
}

/**
 * The full answer rendered on the page: deterministic compute +
 * narrator output (or hard-refusal stub).
 */
export interface NarratedAnswer extends ComputedAnswer {
  narrator: NarratorOutput
  /** What narrator-prompt version was used. */
  narrator_prompt_version: string
}

/** The page's calibration metadata pill. */
export interface PageCalibration {
  venue_id: string
  venue_label: string
  /** % of attribution_events still classified under v1 prompts. */
  v1_classified_pct: number
  v1_classified_count: number
  total_classified_count: number
  /** Most-recent classification timestamp across all questions. */
  data_freshness_iso: string
  /** Narrator prompt version. */
  narrator_prompt_version: string
  /** Per-prompt v1 vs v2 disclosure. */
  prompt_versions_present: string[]
}

/** Top-level wire shape for the page hydrate. */
export interface ChannelTruthPagePayload {
  ok: boolean
  calibration: PageCalibration
  answers: NarratedAnswer[]
  /** Question ids that were SUGGESTED but not answerable for this venue. */
  suggested_not_answerable: { question_id: ChannelTruthQuestionId; reason: string }[]
  error?: string
}
