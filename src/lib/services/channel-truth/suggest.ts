/**
 * Wave 24 — suggestion engine.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (suggest only questions answerable
 *     by the venue's data; never propose a question whose data is missing)
 *
 * Given an AttributionDataset, ranks which questions are answerable for
 * THIS venue and returns the top N (default 7). The page renders only
 * the answerable set + a section noting which questions were considered
 * but lacked data.
 *
 * Suggestion logic is rule-based (no LLM call). Per Wave 21: the
 * suggestion ranking is itself a measurement system — bias it would
 * compound through the rest of the page.
 */

import type { AttributionDataset } from './data-loader'
import { ALL_QUESTION_IDS } from './registry'
import type { ChannelTruthQuestionId } from './types'
import { normalisePlatform } from './data-loader'

export interface SuggestionResult {
  answerable: ChannelTruthQuestionId[]
  not_answerable: { question_id: ChannelTruthQuestionId; reason: string }[]
}

export function suggestQuestions(
  dataset: AttributionDataset,
  maxN: number = 7,
): SuggestionResult {
  // Build cheap precheck signals.
  const knotEventCount = dataset.attribution.filter(
    (a) => normalisePlatform(a.source_platform) === 'the_knot',
  ).length
  const knotSpendCount = dataset.marketingSpend.filter((s) =>
    (s.channel ?? '').toLowerCase().includes('knot'),
  ).length
  const aiToolDiscoveryCount = dataset.discovery.filter(
    (d) => d.canonical_source === 'ai_tool',
  ).length
  const crmSourceDisagreementCount = dataset.crmSourceDisagreements.length
  const totalWeddings = dataset.weddings.length

  const answerable: ChannelTruthQuestionId[] = []
  const notAnswerable: { question_id: ChannelTruthQuestionId; reason: string }[] = []

  for (const qid of ALL_QUESTION_IDS) {
    const reason = checkAnswerable(qid, {
      knotEventCount,
      knotSpendCount,
      aiToolDiscoveryCount,
      crmSourceDisagreementCount,
      totalWeddings,
    })
    if (reason === null) {
      answerable.push(qid)
    } else {
      notAnswerable.push({ question_id: qid, reason })
    }
  }

  return {
    answerable: answerable.slice(0, maxN),
    not_answerable: notAnswerable,
  }
}

interface PrecheckSignals {
  knotEventCount: number
  knotSpendCount: number
  aiToolDiscoveryCount: number
  crmSourceDisagreementCount: number
  totalWeddings: number
}

function checkAnswerable(
  qid: ChannelTruthQuestionId,
  s: PrecheckSignals,
): string | null {
  switch (qid) {
    case 'knot_targeted_vs_broadcast_conversion':
      if (s.knotEventCount < 5) return `Only ${s.knotEventCount} Knot attribution events.`
      return null
    case 'knot_real_cac_excluding_broadcast':
      if (s.knotEventCount < 5) return `Only ${s.knotEventCount} Knot attribution events.`
      if (s.knotSpendCount === 0) return 'No Knot marketing_spend_records rows.'
      return null
    case 'knot_apparent_vs_real_breakdown':
      if (s.knotEventCount < 5) return `Only ${s.knotEventCount} Knot attribution events.`
      return null
    case 'stated_vs_forensic_channel_mix':
      // Always show — refusal is handled in compute when zero disagreements.
      return null
    case 'ai_tool_cohort_difference':
      if (s.aiToolDiscoveryCount < 5)
        return `Only ${s.aiToolDiscoveryCount} discovery_sources rows tagged ai_tool (need 5).`
      return null
    case 'similar_platforms_distorting_cac':
      if (s.knotEventCount + s.totalWeddings < 20)
        return 'Insufficient attribution events to compare platforms.'
      return null
    case 'recent_month_vs_trailing_average':
      if (s.totalWeddings < 30) return `Only ${s.totalWeddings} weddings total (need 30 for temporal baseline).`
      return null
  }
}
