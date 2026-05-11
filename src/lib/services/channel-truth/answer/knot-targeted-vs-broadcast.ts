/**
 * Wave 24 — answer compute: Is Knot actually sending you couples who
 * want your venue?
 *
 * Reads attribution_events filtered to Knot, splits by intent_class,
 * computes conversion-to-booked per intent bucket via wedding status,
 * returns cells the narrator turns into prose.
 *
 * Hedges per Pattern 12: the data could land either direction. If
 * targeted converts higher, the narration says so; if broadcast
 * converts higher (counter-intuitive — the doctrine case), it says
 * THAT. The compute function never imposes a direction.
 */

import type { AttributionDataset } from '../data-loader'
import { normalisePlatform } from '../data-loader'
import {
  aggregateContaminationPct,
  deriveConfidenceLevel,
  makeProportionCell,
} from '../airtightness'
import { QUESTION_REGISTRY } from '../registry'
import type { ComputedAnswer, EvidenceWedding } from '../types'

const QID = 'knot_targeted_vs_broadcast_conversion' as const

export function answerKnotTargetedVsBroadcastConversion(
  dataset: AttributionDataset,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]
  const minSample = meta.default_min_sample_size

  // Filter to Knot attribution events.
  const knotEvents = dataset.attribution.filter(
    (a) => normalisePlatform(a.source_platform) === 'the_knot',
  )

  // Bucket weddings (NOT events — one wedding can have multiple AEs;
  // we dedup by wedding_id so conversion math is per-couple, not per-
  // touchpoint).
  const targetedWeddings = new Set<string>()
  const broadcastWeddings = new Set<string>()
  const targetedPromptVersions: (string | null)[] = []
  const broadcastPromptVersions: (string | null)[] = []
  // Track which weddings have intent ambiguity: prefer the FIRST non-
  // unknown intent_class seen per wedding (intent classification is
  // per-event but the funnel conversion question is per-wedding).
  const weddingIntent = new Map<string, 'targeted' | 'broadcast' | 'validation' | 'unknown'>()
  const weddingPromptVersion = new Map<string, string | null>()

  for (const e of knotEvents) {
    if (!e.wedding_id) continue
    const cur = weddingIntent.get(e.wedding_id) ?? 'unknown'
    if (cur === 'unknown' && e.intent_class) {
      weddingIntent.set(e.wedding_id, e.intent_class as 'targeted' | 'broadcast' | 'validation' | 'unknown')
      weddingPromptVersion.set(e.wedding_id, e.prompt_version_classified_under)
    }
  }

  for (const [wid, intent] of weddingIntent.entries()) {
    if (intent === 'targeted') {
      targetedWeddings.add(wid)
      targetedPromptVersions.push(weddingPromptVersion.get(wid) ?? null)
    } else if (intent === 'broadcast') {
      broadcastWeddings.add(wid)
      broadcastPromptVersions.push(weddingPromptVersion.get(wid) ?? null)
    }
  }

  // Booked count per bucket.
  let targetedBooked = 0
  let broadcastBooked = 0
  for (const wid of targetedWeddings) {
    const w = dataset.weddingById.get(wid)
    if (w && (w.status === 'booked' || w.booked_at !== null)) targetedBooked += 1
  }
  for (const wid of broadcastWeddings) {
    const w = dataset.weddingById.get(wid)
    if (w && (w.status === 'booked' || w.booked_at !== null)) broadcastBooked += 1
  }

  const targetedCell = makeProportionCell({
    label: 'knot_targeted_conversion',
    numerator: targetedBooked,
    denominator: targetedWeddings.size,
    promptVersions: targetedPromptVersions,
    contributingWeddingIds: [...targetedWeddings],
  })
  const broadcastCell = makeProportionCell({
    label: 'knot_broadcast_conversion',
    numerator: broadcastBooked,
    denominator: broadcastWeddings.size,
    promptVersions: broadcastPromptVersions,
    contributingWeddingIds: [...broadcastWeddings],
  })
  const cells = [targetedCell, broadcastCell]

  // Build evidence-wedding rows (up to 50 across both buckets).
  const evidenceWeddings: EvidenceWedding[] = []
  const seen = new Set<string>()
  const append = (wid: string, bucket: 'targeted' | 'broadcast') => {
    if (evidenceWeddings.length >= 50) return
    if (seen.has(wid)) return
    const w = dataset.weddingById.get(wid)
    if (!w) return
    seen.add(wid)
    evidenceWeddings.push({
      wedding_id: wid,
      display_label: wid.slice(0, 8),
      annotation: `${bucket} Knot inquiry · status ${w.status ?? '(unknown)'}`,
      source_platform: 'the_knot',
      intent_class: bucket,
      role: null,
      v1_contaminated: (weddingPromptVersion.get(wid) ?? '').endsWith('.v1'),
    })
  }
  for (const wid of targetedWeddings) append(wid, 'targeted')
  for (const wid of broadcastWeddings) append(wid, 'broadcast')

  // Hard refusal: zero events of either bucket = refuse with the
  // descriptive reason (the page renders this as a "data not yet
  // captured" stub).
  if (targetedWeddings.size === 0 && broadcastWeddings.size === 0) {
    return buildHardRefusal(dataset, 'No classified Knot inquiries with intent_class set. Run reclassify-intent first.')
  }

  // promptVersionsUsed (deduped)
  const pvSet = new Set<string>()
  for (const pv of [...targetedPromptVersions, ...broadcastPromptVersions]) {
    if (pv) pvSet.add(pv)
  }

  return {
    question_id: QID,
    question_text: meta.question_text,
    compute_signature: meta.compute_signature,
    computed_at_iso: new Date().toISOString(),
    cells,
    total_sample_size: targetedWeddings.size + broadcastWeddings.size,
    confidence_level: deriveConfidenceLevel(cells),
    min_sample_size: minSample,
    v1_contamination_pct: aggregateContaminationPct(cells),
    data_freshness_iso: dataset.data_freshness_iso,
    evidence_weddings: evidenceWeddings,
    context_notes: [
      `${targetedWeddings.size} Knot inquiries classified targeted; ${broadcastWeddings.size} classified broadcast.`,
      'Conversion = wedding.status=booked OR wedding.booked_at != null.',
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
