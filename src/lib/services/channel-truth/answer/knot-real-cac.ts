/**
 * Wave 24 — answer compute: What's your real Knot CAC when broadcast
 * inquiries are excluded?
 *
 * Apparent CAC = total Knot spend (over the available window) /
 *   N booked weddings attributed to Knot.
 *
 * Real CAC = total Knot spend / N booked weddings attributed to Knot
 *   where intent_class IN ('targeted', 'unknown', 'validation').
 *
 * The gap is the doctrine point: a venue's "Knot CAC" is artificially
 * low when broadcast bookings are folded into the denominator, because
 * those couples didn't actively pick the venue.
 *
 * Hedges on thin data: if N booked is < 5 in either bucket, the cell
 * carries the headline as null + narrator will refuse / hedge.
 */

import type { AttributionDataset } from '../data-loader'
import { normalisePlatform } from '../data-loader'
import {
  aggregateContaminationPct,
  deriveConfidenceLevel,
  makeFreeformCell,
} from '../airtightness'
import { QUESTION_REGISTRY } from '../registry'
import type { ComputedAnswer, EvidenceWedding } from '../types'

const QID = 'knot_real_cac_excluding_broadcast' as const

export function answerKnotRealCacExcludingBroadcast(
  dataset: AttributionDataset,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]

  // Total Knot spend in the dataset window. marketing_spend_records
  // uses .channel; the_knot channels show up as 'theknot_fee' /
  // 'the_knot' / 'theknot'.
  const knotSpendCents = dataset.marketingSpend
    .filter((s) => {
      const c = (s.channel ?? '').toLowerCase()
      return c.includes('knot') // 'theknot_fee', 'the_knot_ads', etc.
    })
    .reduce((sum, s) => sum + (s.amount_cents ?? 0), 0)

  // Knot attribution events.
  const knotEvents = dataset.attribution.filter(
    (a) => normalisePlatform(a.source_platform) === 'the_knot',
  )

  // Per wedding: pick first non-unknown intent.
  const weddingIntent = new Map<string, string>()
  const weddingPromptVersion = new Map<string, string | null>()
  for (const e of knotEvents) {
    if (!e.wedding_id) continue
    if (!weddingIntent.has(e.wedding_id) && e.intent_class) {
      weddingIntent.set(e.wedding_id, e.intent_class)
      weddingPromptVersion.set(e.wedding_id, e.prompt_version_classified_under)
    }
  }

  // Booked-Knot weddings (apparent).
  const apparentBooked: string[] = []
  // Booked-Knot weddings excluding intent=broadcast (real).
  const realBooked: string[] = []
  const apparentPVs: (string | null)[] = []
  const realPVs: (string | null)[] = []

  for (const e of knotEvents) {
    if (!e.wedding_id) continue
    const w = dataset.weddingById.get(e.wedding_id)
    if (!w) continue
    if (!(w.status === 'booked' || w.booked_at !== null)) continue
    if (!apparentBooked.includes(e.wedding_id)) {
      apparentBooked.push(e.wedding_id)
      apparentPVs.push(e.prompt_version_classified_under)
    }
    const intent = weddingIntent.get(e.wedding_id)
    if (intent !== 'broadcast' && !realBooked.includes(e.wedding_id)) {
      realBooked.push(e.wedding_id)
      realPVs.push(e.prompt_version_classified_under)
    }
  }

  const apparentCacCents = apparentBooked.length > 0
    ? Math.round(knotSpendCents / apparentBooked.length)
    : null
  const realCacCents = realBooked.length > 0
    ? Math.round(knotSpendCents / realBooked.length)
    : null

  const cells = [
    makeFreeformCell({
      label: 'knot_spend_total_cents',
      n: dataset.marketingSpend.filter((s) => (s.channel ?? '').toLowerCase().includes('knot')).length,
      headline_value: knotSpendCents,
      promptVersions: [],
      contributingWeddingIds: [],
    }),
    makeFreeformCell({
      label: 'knot_apparent_cac_cents',
      n: apparentBooked.length,
      headline_value: apparentCacCents,
      promptVersions: apparentPVs,
      contributingWeddingIds: apparentBooked,
    }),
    makeFreeformCell({
      label: 'knot_real_cac_cents_excluding_broadcast',
      n: realBooked.length,
      headline_value: realCacCents,
      promptVersions: realPVs,
      contributingWeddingIds: realBooked,
    }),
  ]

  if (knotSpendCents === 0) {
    return buildHardRefusal(
      dataset,
      'No marketing_spend_records rows tagged as Knot. CAC math requires logged spend.',
    )
  }
  if (apparentBooked.length === 0 && realBooked.length === 0) {
    return buildHardRefusal(
      dataset,
      'No booked weddings attributed to Knot. CAC denominator is zero.',
    )
  }

  const evidenceWeddings: EvidenceWedding[] = []
  const seen = new Set<string>()
  for (const wid of apparentBooked) {
    if (evidenceWeddings.length >= 50 || seen.has(wid)) continue
    const w = dataset.weddingById.get(wid)
    if (!w) continue
    seen.add(wid)
    const intent = weddingIntent.get(wid) ?? 'unknown'
    evidenceWeddings.push({
      wedding_id: wid,
      display_label: wid.slice(0, 8),
      annotation: `booked · intent ${intent} · value $${w.booking_value ?? '?'}`,
      source_platform: 'the_knot',
      intent_class: intent,
      role: null,
      v1_contaminated: (weddingPromptVersion.get(wid) ?? '').endsWith('.v1'),
    })
  }

  const pvSet = new Set<string>()
  for (const pv of [...apparentPVs, ...realPVs]) {
    if (pv) pvSet.add(pv)
  }

  return {
    question_id: QID,
    question_text: meta.question_text,
    compute_signature: meta.compute_signature,
    computed_at_iso: new Date().toISOString(),
    cells,
    total_sample_size: apparentBooked.length,
    confidence_level: deriveConfidenceLevel(cells.filter((c) => c.label !== 'knot_spend_total_cents')),
    min_sample_size: meta.default_min_sample_size,
    v1_contamination_pct: aggregateContaminationPct(cells),
    data_freshness_iso: dataset.data_freshness_iso,
    evidence_weddings: evidenceWeddings,
    context_notes: [
      `Apparent CAC denominator includes ${apparentBooked.length} booked Knot weddings.`,
      `Real CAC excludes intent=broadcast: ${realBooked.length} denominator.`,
      `Knot spend window: ${dataset.marketingSpend.filter((s) => (s.channel ?? '').toLowerCase().includes('knot')).length} spend rows totalling $${(knotSpendCents / 100).toFixed(0)}.`,
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
