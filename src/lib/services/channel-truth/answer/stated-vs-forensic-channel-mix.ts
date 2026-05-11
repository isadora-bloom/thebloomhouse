/**
 * Wave 24 — answer compute: What's the gap between your stated channel
 * mix and your forensic channel mix?
 *
 * Reads disagreement_findings axis=crm_source (Wave 17). When stated
 * source disagrees with forensic source for a wedding, the disagreement
 * itself is the intelligence (per
 * feedback_self_reported_sources_not_truth.md). This answer surfaces
 * the count of disagreements + the most common stated→forensic shift
 * pairs.
 */

import type { AttributionDataset } from '../data-loader'
import {
  aggregateContaminationPct,
  deriveConfidenceLevel,
  makeCountCell,
  makeFreeformCell,
} from '../airtightness'
import { QUESTION_REGISTRY } from '../registry'
import type { ComputedAnswer, EvidenceWedding } from '../types'

const QID = 'stated_vs_forensic_channel_mix' as const

export function answerStatedVsForensicChannelMix(
  dataset: AttributionDataset,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]

  const active = dataset.crmSourceDisagreements

  if (active.length === 0) {
    return buildHardRefusal(
      dataset,
      'No active crm_source disagreements detected. Wave 17 has either not run for this venue or every wedding agrees stated == forensic.',
    )
  }

  // Build a histogram of stated → forensic shifts.
  const shiftCounts = new Map<string, number>()
  const shiftWeddings = new Map<string, string[]>()
  for (const d of active) {
    const stated = stringifyValue(d.stated_value)
    const forensic = stringifyValue(d.forensic_value)
    const key = `${stated} → ${forensic}`
    shiftCounts.set(key, (shiftCounts.get(key) ?? 0) + 1)
    if (!shiftWeddings.has(key)) shiftWeddings.set(key, [])
    if (d.wedding_id) shiftWeddings.get(key)!.push(d.wedding_id)
  }
  const topShifts = [...shiftCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  const weddingsTouched = new Set<string>()
  for (const d of active) if (d.wedding_id) weddingsTouched.add(d.wedding_id)

  const cells = [
    makeCountCell({
      label: 'active_disagreements',
      count: active.length,
      promptVersions: [],
      contributingWeddingIds: [...weddingsTouched],
    }),
    makeCountCell({
      label: 'weddings_with_channel_disagreement',
      count: weddingsTouched.size,
      promptVersions: [],
      contributingWeddingIds: [...weddingsTouched],
    }),
    makeFreeformCell({
      label: 'top_stated_to_forensic_shifts',
      n: topShifts.length,
      headline_value: topShifts.map(([k, n]) => `${k} (n=${n})`),
      promptVersions: [],
      contributingWeddingIds: topShifts.flatMap(([k]) => shiftWeddings.get(k) ?? []).slice(0, 50),
    }),
  ]

  const evidenceWeddings: EvidenceWedding[] = []
  const seen = new Set<string>()
  for (const d of active) {
    if (evidenceWeddings.length >= 50) break
    if (!d.wedding_id || seen.has(d.wedding_id)) continue
    const w = dataset.weddingById.get(d.wedding_id)
    if (!w) continue
    seen.add(d.wedding_id)
    evidenceWeddings.push({
      wedding_id: d.wedding_id,
      display_label: d.wedding_id.slice(0, 8),
      annotation: `stated=${stringifyValue(d.stated_value)} · forensic=${stringifyValue(d.forensic_value)}`,
      source_platform: null,
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
    total_sample_size: weddingsTouched.size,
    confidence_level: deriveConfidenceLevel(cells.slice(0, 2)),
    min_sample_size: meta.default_min_sample_size,
    v1_contamination_pct: aggregateContaminationPct(cells),
    data_freshness_iso: dataset.data_freshness_iso,
    evidence_weddings: evidenceWeddings,
    context_notes: [
      'Source: Wave 17 disagreement_findings, axis=crm_source, status=active.',
      'Each shift = one wedding whose stated source disagrees with forensic.',
    ],
    hard_refusal: null,
    prompt_versions_used: [],
  }
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '(null)'
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
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
