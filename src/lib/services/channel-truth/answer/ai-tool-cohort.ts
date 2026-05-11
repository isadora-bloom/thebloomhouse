/**
 * Wave 24 — answer compute: How are couples who used AI tools to find
 * you different from couples from other channels?
 *
 * Reads discovery_sources canonical_source='ai_tool' (Calendly Q&A
 * "where did you hear about us" answers that mapped to ChatGPT /
 * Perplexity / Claude / etc per Wave 15).
 *
 * Compares booked-rate + average-booking-value of the ai_tool cohort
 * vs the rest. Refuses if the ai_tool cohort has fewer than 5
 * discovery rows — that's the doctrine threshold for surfacing this
 * specific question.
 */

import type { AttributionDataset } from '../data-loader'
import {
  aggregateContaminationPct,
  deriveConfidenceLevel,
  makeFreeformCell,
  makeProportionCell,
} from '../airtightness'
import { QUESTION_REGISTRY } from '../registry'
import type { ComputedAnswer, EvidenceWedding } from '../types'

const QID = 'ai_tool_cohort_difference' as const

export function answerAiToolCohortDifference(
  dataset: AttributionDataset,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]

  const aiToolDiscoveries = dataset.discovery.filter(
    (d) => d.canonical_source === 'ai_tool',
  )
  const aiToolWeddingIds = new Set<string>()
  for (const d of aiToolDiscoveries) {
    if (d.wedding_id) aiToolWeddingIds.add(d.wedding_id)
  }

  if (aiToolWeddingIds.size < 5) {
    return buildHardRefusal(
      dataset,
      `Only ${aiToolWeddingIds.size} weddings with discovery_sources.canonical_source='ai_tool'. Doctrine threshold is 5. Returns when more data is captured.`,
    )
  }

  // Other-channel cohort = all weddings that have a discovery row
  // canonical != ai_tool, OR have no discovery row at all.
  const aiBooked: string[] = []
  let aiBookedValueTotal = 0
  for (const wid of aiToolWeddingIds) {
    const w = dataset.weddingById.get(wid)
    if (!w) continue
    if (w.status === 'booked' || w.booked_at !== null) {
      aiBooked.push(wid)
      aiBookedValueTotal += w.booking_value ?? 0
    }
  }
  const aiBookedRate = aiToolWeddingIds.size > 0 ? aiBooked.length / aiToolWeddingIds.size : 0
  const aiAvgValue = aiBooked.length > 0 ? aiBookedValueTotal / aiBooked.length : 0

  const otherWeddings = dataset.weddings.filter((w) => !aiToolWeddingIds.has(w.id))
  const otherBooked = otherWeddings.filter((w) => w.status === 'booked' || w.booked_at !== null)
  const otherBookedValueTotal = otherBooked.reduce((sum, w) => sum + (w.booking_value ?? 0), 0)
  const otherAvgValue = otherBooked.length > 0 ? otherBookedValueTotal / otherBooked.length : 0

  const aiCohortCell = makeProportionCell({
    label: 'ai_tool_booked_rate',
    numerator: aiBooked.length,
    denominator: aiToolWeddingIds.size,
    promptVersions: [],
    contributingWeddingIds: [...aiToolWeddingIds],
  })
  const otherCohortCell = makeProportionCell({
    label: 'other_channels_booked_rate',
    numerator: otherBooked.length,
    denominator: otherWeddings.length,
    promptVersions: [],
    contributingWeddingIds: otherWeddings.slice(0, 50).map((w) => w.id),
  })
  const valueCell = makeFreeformCell({
    label: 'ai_vs_other_avg_booking_value',
    n: aiBooked.length + otherBooked.length,
    headline_value: {
      ai_tool_avg_booking_value_usd: Math.round(aiAvgValue),
      other_channels_avg_booking_value_usd: Math.round(otherAvgValue),
    },
    promptVersions: [],
    contributingWeddingIds: [...aiBooked, ...otherBooked.slice(0, 25).map((w) => w.id)],
  })
  const cells = [aiCohortCell, otherCohortCell, valueCell]

  const evidenceWeddings: EvidenceWedding[] = []
  for (const wid of aiToolWeddingIds) {
    if (evidenceWeddings.length >= 50) break
    const w = dataset.weddingById.get(wid)
    if (!w) continue
    evidenceWeddings.push({
      wedding_id: wid,
      display_label: wid.slice(0, 8),
      annotation: `discovery=ai_tool · status ${w.status ?? '(unknown)'}`,
      source_platform: w.source,
      intent_class: null,
      role: null,
      v1_contaminated: false,
    })
  }

  return {
    question_id: QID,
    question_text: meta.question_text,
    compute_signature: meta.compute_signature,
    computed_at_iso: new Date().toISOString(),
    cells,
    total_sample_size: aiToolWeddingIds.size,
    confidence_level: deriveConfidenceLevel([aiCohortCell, otherCohortCell]),
    min_sample_size: meta.default_min_sample_size,
    v1_contamination_pct: aggregateContaminationPct(cells),
    data_freshness_iso: dataset.data_freshness_iso,
    evidence_weddings: evidenceWeddings,
    context_notes: [
      `${aiBooked.length} booked weddings out of ${aiToolWeddingIds.size} who self-reported AI-tool discovery.`,
      'Self-reported source is captured via Calendly Q&A and mapped to canonical_source.',
      'Per feedback_self_reported_sources_not_truth.md: AI tool self-report is high-signal but not authoritative — booking-value gap could indicate a higher-quality referral, not just a different funnel.',
    ],
    hard_refusal: null,
    prompt_versions_used: [],
  }
}

function buildHardRefusal(
  dataset: AttributionDataset,
  reason: string,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]
  return {
    question_id: QID,
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
    hard_refusal: { refused: true, reason },
    prompt_versions_used: [],
  }
}
