/**
 * Bloom House — Wave 24 Channel Truth question registry.
 *
 * Central static metadata for each pre-built question. The suggestion
 * engine reads this; the page resolves question_id → compute_signature
 * for the reproducibility footer here.
 *
 * Adding a new question:
 *   1. Add a ChannelTruthQuestionId to types.ts.
 *   2. Add a row here with compute_signature matching the answer/ file.
 *   3. Add answer/<id>.ts exporting compute({ venueId, supabase }).
 *   4. Wire it into compute-all.ts.
 */

import type {
  ChannelTruthQuestionId,
  ChannelTruthQuestionMeta,
} from './types'

export const QUESTION_REGISTRY: Record<
  ChannelTruthQuestionId,
  ChannelTruthQuestionMeta
> = {
  knot_targeted_vs_broadcast_conversion: {
    id: 'knot_targeted_vs_broadcast_conversion',
    question_text:
      'Is Knot actually sending you couples who want your venue?',
    compute_signature: 'answerKnotTargetedVsBroadcastConversion',
    default_min_sample_size: 10,
  },
  knot_real_cac_excluding_broadcast: {
    id: 'knot_real_cac_excluding_broadcast',
    question_text:
      "What's your real Knot CAC when broadcast inquiries are excluded?",
    compute_signature: 'answerKnotRealCacExcludingBroadcast',
    default_min_sample_size: 10,
  },
  knot_apparent_vs_real_breakdown: {
    id: 'knot_apparent_vs_real_breakdown',
    question_text:
      'How many of your apparent Knot leads actually inquired through Knot?',
    compute_signature: 'answerKnotApparentVsRealBreakdown',
    default_min_sample_size: 10,
  },
  stated_vs_forensic_channel_mix: {
    id: 'stated_vs_forensic_channel_mix',
    question_text:
      "What's the gap between your stated channel mix and your forensic channel mix?",
    compute_signature: 'answerStatedVsForensicChannelMix',
    default_min_sample_size: 5,
  },
  ai_tool_cohort_difference: {
    id: 'ai_tool_cohort_difference',
    question_text:
      'How are couples who used AI tools to find you different from couples from other channels?',
    compute_signature: 'answerAiToolCohortDifference',
    default_min_sample_size: 5,
  },
  similar_platforms_distorting_cac: {
    id: 'similar_platforms_distorting_cac',
    question_text:
      'Which other listing platforms might be distorting your CAC math the way Knot does?',
    compute_signature: 'answerSimilarPlatformsDistortingCac',
    default_min_sample_size: 10,
  },
  recent_month_vs_trailing_average: {
    id: 'recent_month_vs_trailing_average',
    question_text:
      "Is your most-recent month's inquiry mix different from your trailing 12-month average?",
    compute_signature: 'answerRecentMonthVsTrailingAverage',
    default_min_sample_size: 8,
  },
}

export const ALL_QUESTION_IDS: ChannelTruthQuestionId[] = Object.keys(
  QUESTION_REGISTRY,
) as ChannelTruthQuestionId[]
