/**
 * Wave 24 — answer compute: Which other listing platforms might be
 * distorting your CAC math the way Knot does?
 *
 * Applies the Knot-style forensic check (apparent leads vs targeted
 * fraction) to every listing platform observed in attribution_events.
 * Returns one row per platform with broadcast share + targeted share +
 * unclassified share. Operator-facing: "WeddingWire shows the same
 * pattern — X% broadcast — investigate."
 *
 * Note: Wave 23 has not yet finished its rollout for HCTG/Brides/Zola/
 * Junebug/Carats/SMP — broadcast classification is mostly Knot+WW for
 * now. So the cells for other platforms will mostly read as
 * "unclassified" until Wave 23 patterns are seeded + re-classification
 * runs. That's surfaced honestly in the narration.
 */

import type { AttributionDataset } from '../data-loader'
import { isListingPlatform, normalisePlatform } from '../data-loader'
import {
  aggregateContaminationPct,
  deriveConfidenceLevel,
  makeFreeformCell,
} from '../airtightness'
import { QUESTION_REGISTRY } from '../registry'
import type { ComputedAnswer, EvidenceWedding } from '../types'

const QID = 'similar_platforms_distorting_cac' as const

export function answerSimilarPlatformsDistortingCac(
  dataset: AttributionDataset,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]

  // Group attribution events by normalised platform, but only for
  // listing platforms (the broadcast-distortion question doesn't apply
  // to organic / website / referral).
  const byPlatform = new Map<
    string,
    {
      targeted: Set<string>
      broadcast: Set<string>
      validation: Set<string>
      unknown: Set<string>
      pvs: (string | null)[]
    }
  >()
  for (const e of dataset.attribution) {
    const platform = normalisePlatform(e.source_platform)
    if (!isListingPlatform(platform)) continue
    if (!e.wedding_id) continue
    let cell = byPlatform.get(platform)
    if (!cell) {
      cell = {
        targeted: new Set(),
        broadcast: new Set(),
        validation: new Set(),
        unknown: new Set(),
        pvs: [],
      }
      byPlatform.set(platform, cell)
    }
    const intent = (e.intent_class ?? 'unknown') as 'targeted' | 'broadcast' | 'validation' | 'unknown'
    cell[intent].add(e.wedding_id)
    cell.pvs.push(e.prompt_version_classified_under)
  }

  if (byPlatform.size === 0) {
    return buildHardRefusal(
      dataset,
      'No listing-platform attribution events. The cross-platform distortion check has nothing to compare.',
    )
  }

  // Build one cell per platform with the broadcast-share if computable.
  const cells = []
  const evidenceWeddings: EvidenceWedding[] = []
  for (const [platform, c] of byPlatform.entries()) {
    const total = c.targeted.size + c.broadcast.size + c.validation.size + c.unknown.size
    const classified = c.targeted.size + c.broadcast.size
    const broadcastSharePct = classified > 0 ? Math.round((c.broadcast.size / classified) * 100) : null
    cells.push(
      makeFreeformCell({
        label: `platform_${platform}`,
        n: total,
        headline_value: {
          platform,
          total_weddings: total,
          targeted: c.targeted.size,
          broadcast: c.broadcast.size,
          validation: c.validation.size,
          unknown: c.unknown.size,
          broadcast_share_pct: broadcastSharePct,
        },
        promptVersions: c.pvs,
        contributingWeddingIds: [...c.targeted, ...c.broadcast].slice(0, 50),
      }),
    )
    for (const wid of c.broadcast) {
      if (evidenceWeddings.length >= 50) break
      const w = dataset.weddingById.get(wid)
      if (!w) continue
      evidenceWeddings.push({
        wedding_id: wid,
        display_label: wid.slice(0, 8),
        annotation: `${platform} · intent=broadcast`,
        source_platform: platform,
        intent_class: 'broadcast',
        role: null,
        v1_contaminated: false,
      })
    }
  }

  const pvSet = new Set<string>()
  for (const c of byPlatform.values()) {
    for (const pv of c.pvs) if (pv) pvSet.add(pv)
  }

  return {
    question_id: QID,
    question_text: meta.question_text,
    compute_signature: meta.compute_signature,
    computed_at_iso: new Date().toISOString(),
    cells,
    total_sample_size: Array.from(byPlatform.values()).reduce(
      (sum, c) => sum + c.targeted.size + c.broadcast.size + c.validation.size + c.unknown.size,
      0,
    ),
    confidence_level: deriveConfidenceLevel(cells),
    min_sample_size: meta.default_min_sample_size,
    v1_contamination_pct: aggregateContaminationPct(cells),
    data_freshness_iso: dataset.data_freshness_iso,
    evidence_weddings: evidenceWeddings,
    context_notes: [
      `${byPlatform.size} listing platforms observed in attribution_events.`,
      'Wave 23 broadcast detection is still seeded primarily for Knot + WeddingWire — other platforms may show high "unclassified" until Wave 23 patterns are seeded and re-classification runs.',
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
