/**
 * Wave 24 — top-level orchestrator.
 *
 * Loads the dataset, runs the suggestion engine, computes each
 * answerable question, narrates each, builds the page calibration pill,
 * and returns the full payload.
 *
 * One call serves the page. Cost: ~7 Sonnet calls per page view in the
 * common case. The audit-snapshot row captures the result so a repeat
 * view for the same operator can re-render without re-narrating.
 */

import { createServiceClient } from '@/lib/supabase/service'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION } from '@/config/prompts/channel-truth-narrator'
import { loadAttributionDataset } from './data-loader'
import { suggestQuestions } from './suggest'
import { narrateAnswer } from './narrate'
import { V1_CONTAMINATED_PROMPT_VERSIONS } from './airtightness'
import { QUESTION_REGISTRY } from './registry'
import type {
  ChannelTruthPagePayload,
  ChannelTruthQuestionId,
  ComputedAnswer,
  NarratedAnswer,
  PageCalibration,
} from './types'

import { answerKnotTargetedVsBroadcastConversion } from './answer/knot-targeted-vs-broadcast'
import { answerKnotRealCacExcludingBroadcast } from './answer/knot-real-cac'
import { answerKnotApparentVsRealBreakdown } from './answer/knot-apparent-vs-real'
import { answerStatedVsForensicChannelMix } from './answer/stated-vs-forensic-channel-mix'
import { answerAiToolCohortDifference } from './answer/ai-tool-cohort'
import { answerSimilarPlatformsDistortingCac } from './answer/similar-platforms'
import { answerRecentMonthVsTrailingAverage } from './answer/recent-month-vs-trailing'
import type { AttributionDataset } from './data-loader'

const COMPUTE_DISPATCH: Record<
  ChannelTruthQuestionId,
  (dataset: AttributionDataset) => ComputedAnswer
> = {
  knot_targeted_vs_broadcast_conversion: answerKnotTargetedVsBroadcastConversion,
  knot_real_cac_excluding_broadcast: answerKnotRealCacExcludingBroadcast,
  knot_apparent_vs_real_breakdown: answerKnotApparentVsRealBreakdown,
  stated_vs_forensic_channel_mix: answerStatedVsForensicChannelMix,
  ai_tool_cohort_difference: answerAiToolCohortDifference,
  similar_platforms_distorting_cac: answerSimilarPlatformsDistortingCac,
  recent_month_vs_trailing_average: answerRecentMonthVsTrailingAverage,
}

export interface ComputeOptions {
  /** Skip the narrator (deterministic-only mode — used by /share). */
  skipNarrator?: boolean
  /** Subset of questions to compute (defaults to all suggested). */
  questionIds?: ChannelTruthQuestionId[]
  supabase?: SupabaseClient
}

export async function computeChannelTruthPage(
  venueId: string,
  options: ComputeOptions = {},
): Promise<ChannelTruthPagePayload> {
  const sb = options.supabase ?? createServiceClient()

  let dataset
  try {
    dataset = await loadAttributionDataset(venueId, sb)
  } catch (err) {
    return {
      ok: false,
      calibration: emptyCalibration(venueId),
      answers: [],
      suggested_not_answerable: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Calibration pill — describes the page-level prompt-version disclosure.
  const calibration = buildCalibration(dataset)

  // Suggestion ranking
  const suggestion = suggestQuestions(dataset, 7)
  const toCompute = options.questionIds ?? suggestion.answerable

  // Compute deterministic answers
  const computed: ComputedAnswer[] = []
  for (const qid of toCompute) {
    const compute = COMPUTE_DISPATCH[qid]
    if (!compute) continue
    try {
      computed.push(compute(dataset))
    } catch (err) {
      // Compute should NEVER throw; if it does we surface a hard refusal
      // rather than 500 the page.
      const reason = err instanceof Error ? err.message : String(err)
      const meta = QUESTION_REGISTRY[qid]
      computed.push({
        question_id: qid,
        question_text: meta.question_text,
        compute_signature: meta.compute_signature,
        computed_at_iso: new Date().toISOString(),
        cells: [],
        total_sample_size: 0,
        confidence_level: 'thin',
        min_sample_size: meta.default_min_sample_size,
        v1_contamination_pct: 0,
        data_freshness_iso: dataset.data_freshness_iso,
        evidence_weddings: [],
        context_notes: [],
        hard_refusal: { refused: true, reason: `compute error: ${reason}` },
        prompt_versions_used: [],
      })
    }
  }

  // Narrate each (sequentially — cost-bounded; ~7 calls per page).
  const narrated: NarratedAnswer[] = []
  for (const a of computed) {
    if (options.skipNarrator) {
      narrated.push({
        ...a,
        narrator: {
          narration_paragraph: '',
          headline_pull_quote: '',
          recommendation_if_any: null,
          refusal_reason: 'narrator skipped',
        },
        narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
      })
      continue
    }
    const { narrator, narrator_prompt_version } = await narrateAnswer({
      answer: a,
      venueLabel: dataset.venueLabel,
      venueId,
    })
    narrated.push({ ...a, narrator, narrator_prompt_version })
  }

  return {
    ok: true,
    calibration,
    answers: narrated,
    suggested_not_answerable: suggestion.not_answerable,
  }
}

function buildCalibration(dataset: AttributionDataset): PageCalibration {
  const pvCounts = new Map<string, number>()
  let v1 = 0
  let total = 0
  for (const a of dataset.attribution) {
    const pv = a.prompt_version_classified_under
    if (pv) {
      pvCounts.set(pv, (pvCounts.get(pv) ?? 0) + 1)
      total += 1
      if (V1_CONTAMINATED_PROMPT_VERSIONS.has(pv)) v1 += 1
    }
  }
  return {
    venue_id: dataset.venueId,
    venue_label: dataset.venueLabel,
    v1_classified_pct: total > 0 ? (v1 / total) * 100 : 0,
    v1_classified_count: v1,
    total_classified_count: total,
    data_freshness_iso: dataset.data_freshness_iso,
    narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
    prompt_versions_present: [...pvCounts.keys()],
  }
}

function emptyCalibration(venueId: string): PageCalibration {
  return {
    venue_id: venueId,
    venue_label: 'venue',
    v1_classified_pct: 0,
    v1_classified_count: 0,
    total_classified_count: 0,
    data_freshness_iso: new Date(0).toISOString(),
    narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
    prompt_versions_present: [],
  }
}

/**
 * Persist a page-view snapshot. Returns the audit row id so the share
 * endpoint can reference it later.
 */
export async function writeAuditSnapshot(args: {
  venueId: string
  viewedBy: string | null
  payload: ChannelTruthPagePayload
  supabase?: SupabaseClient
}): Promise<{ id: string | null; error: string | null }> {
  const sb = args.supabase ?? createServiceClient()
  const questionIds = args.payload.answers.map((a) => a.question_id)
  const snapshot = {
    questions: args.payload.answers.map((a) => ({
      question_id: a.question_id,
      computed_at_iso: a.computed_at_iso,
      headline_value: a.narrator.headline_pull_quote || a.hard_refusal?.reason || '(refused)',
      sample_size: Object.fromEntries(a.cells.map((c) => [c.label, c.n])),
      confidence_level: a.confidence_level,
      evidence_wedding_ids: a.evidence_weddings.map((e) => e.wedding_id).slice(0, 50),
      prompt_versions_used: a.prompt_versions_used,
      v1_contamination_pct: a.v1_contamination_pct,
      data_freshness_iso: a.data_freshness_iso,
      deterministic_sql_signature: `fn:${a.compute_signature}`,
    })),
    page_calibration: {
      v1_pct_at_view_time: args.payload.calibration.v1_classified_pct,
      data_freshness_iso: args.payload.calibration.data_freshness_iso,
      narrator_prompt_version: args.payload.calibration.narrator_prompt_version,
    },
  }
  const { data, error } = await sb
    .from('channel_truth_audits')
    .insert({
      venue_id: args.venueId,
      viewed_by: args.viewedBy,
      question_ids: questionIds,
      snapshot_jsonb: snapshot,
    })
    .select('id')
    .single()
  if (error) return { id: null, error: error.message }
  return { id: (data as { id: string }).id, error: null }
}
