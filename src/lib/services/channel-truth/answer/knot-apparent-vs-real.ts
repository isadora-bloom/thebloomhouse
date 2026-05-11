/**
 * Wave 24 — answer compute: How many of your apparent Knot leads
 * actually inquired through Knot?
 *
 * Returns the role/intent breakdown for Knot:
 *   - targeted (couple actively chose; first-touch on Knot)
 *   - broadcast (Knot's algorithm pushed; cross-platform footprint)
 *   - unknown (not yet classified; defaults to broadcast-eligible)
 *
 * Compares to the "apparent Knot leads" headcount (every wedding with
 * any Knot attribution event). The gap = leads the operator THINKS are
 * Knot vs leads who actually directly inquired through Knot.
 */

import type { AttributionDataset } from '../data-loader'
import { normalisePlatform } from '../data-loader'
import {
  aggregateContaminationPct,
  deriveConfidenceLevel,
  makeCountCell,
} from '../airtightness'
import { QUESTION_REGISTRY } from '../registry'
import type { ComputedAnswer, EvidenceWedding } from '../types'

const QID = 'knot_apparent_vs_real_breakdown' as const

export function answerKnotApparentVsRealBreakdown(
  dataset: AttributionDataset,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]

  const knotEvents = dataset.attribution.filter(
    (a) => normalisePlatform(a.source_platform) === 'the_knot',
  )

  const weddingIntent = new Map<string, string>()
  const weddingPV = new Map<string, string | null>()
  for (const e of knotEvents) {
    if (!e.wedding_id) continue
    if (!weddingIntent.has(e.wedding_id) && e.intent_class) {
      weddingIntent.set(e.wedding_id, e.intent_class)
      weddingPV.set(e.wedding_id, e.prompt_version_classified_under)
    }
  }

  const apparentWeddings = new Set<string>()
  for (const e of knotEvents) {
    if (e.wedding_id) apparentWeddings.add(e.wedding_id)
  }

  const targeted: string[] = []
  const broadcast: string[] = []
  const validation: string[] = []
  const unknown: string[] = []
  const pvByBucket: Record<string, (string | null)[]> = {
    targeted: [],
    broadcast: [],
    validation: [],
    unknown: [],
  }
  for (const wid of apparentWeddings) {
    const intent = weddingIntent.get(wid) ?? 'unknown'
    const pv = weddingPV.get(wid) ?? null
    if (intent === 'targeted') {
      targeted.push(wid)
      pvByBucket.targeted.push(pv)
    } else if (intent === 'broadcast') {
      broadcast.push(wid)
      pvByBucket.broadcast.push(pv)
    } else if (intent === 'validation') {
      validation.push(wid)
      pvByBucket.validation.push(pv)
    } else {
      unknown.push(wid)
      pvByBucket.unknown.push(pv)
    }
  }

  const cells = [
    makeCountCell({
      label: 'apparent_knot_weddings',
      count: apparentWeddings.size,
      promptVersions: [],
      contributingWeddingIds: [...apparentWeddings],
    }),
    makeCountCell({
      label: 'targeted_knot_weddings',
      count: targeted.length,
      promptVersions: pvByBucket.targeted,
      contributingWeddingIds: targeted,
    }),
    makeCountCell({
      label: 'broadcast_knot_weddings',
      count: broadcast.length,
      promptVersions: pvByBucket.broadcast,
      contributingWeddingIds: broadcast,
    }),
    makeCountCell({
      label: 'validation_knot_weddings',
      count: validation.length,
      promptVersions: pvByBucket.validation,
      contributingWeddingIds: validation,
    }),
    makeCountCell({
      label: 'unknown_knot_weddings',
      count: unknown.length,
      promptVersions: pvByBucket.unknown,
      contributingWeddingIds: unknown,
    }),
  ]

  if (apparentWeddings.size === 0) {
    return buildHardRefusal(
      dataset,
      'No Knot attribution events for this venue. The breakdown has no rows to bucket.',
    )
  }

  const evidenceWeddings: EvidenceWedding[] = []
  const seen = new Set<string>()
  const append = (wid: string, bucket: string) => {
    if (evidenceWeddings.length >= 50 || seen.has(wid)) return
    const w = dataset.weddingById.get(wid)
    if (!w) return
    seen.add(wid)
    evidenceWeddings.push({
      wedding_id: wid,
      display_label: wid.slice(0, 8),
      annotation: `${bucket} · status ${w.status ?? '(unknown)'}`,
      source_platform: 'the_knot',
      intent_class: bucket,
      role: null,
      v1_contaminated: (weddingPV.get(wid) ?? '').endsWith('.v1'),
    })
  }
  for (const wid of targeted) append(wid, 'targeted')
  for (const wid of broadcast) append(wid, 'broadcast')
  for (const wid of validation) append(wid, 'validation')
  for (const wid of unknown) append(wid, 'unknown')

  const pvSet = new Set<string>()
  for (const arr of Object.values(pvByBucket)) {
    for (const pv of arr) if (pv) pvSet.add(pv)
  }

  return {
    question_id: QID,
    question_text: meta.question_text,
    compute_signature: meta.compute_signature,
    computed_at_iso: new Date().toISOString(),
    cells,
    total_sample_size: apparentWeddings.size,
    confidence_level: deriveConfidenceLevel(cells.filter((c) => c.label === 'apparent_knot_weddings')),
    min_sample_size: meta.default_min_sample_size,
    v1_contamination_pct: aggregateContaminationPct(cells),
    data_freshness_iso: dataset.data_freshness_iso,
    evidence_weddings: evidenceWeddings,
    context_notes: [
      `Apparent Knot leads include every wedding with any Knot attribution event.`,
      `${unknown.length} of ${apparentWeddings.size} apparent Knot weddings are still unclassified (intent_class=unknown).`,
    ],
    hard_refusal: null,
    prompt_versions_used: [...pvSet],
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
