/**
 * Wave 24 — answer compute: Is your most-recent month's inquiry mix
 * different from your trailing 12-month average?
 *
 * Compares the per-channel inquiry shares for the last 30 days vs the
 * previous 360 days. Surfaces top channels whose share shifted by > 10
 * percentage points either direction.
 *
 * Refuses if trailing 12mo has fewer than 30 inquiries (the comparison
 * baseline is too thin).
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

const QID = 'recent_month_vs_trailing_average' as const

export function answerRecentMonthVsTrailingAverage(
  dataset: AttributionDataset,
): ComputedAnswer {
  const meta = QUESTION_REGISTRY[QID]

  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const recentCutoff = now - 30 * dayMs
  const trailingCutoff = now - 390 * dayMs

  // Build per-wedding first-touch platform from attribution_events
  // ordered by decided_at ASC.
  const sortedEvents = [...dataset.attribution].sort((a, b) => {
    if (!a.decided_at) return 1
    if (!b.decided_at) return -1
    return a.decided_at.localeCompare(b.decided_at)
  })
  const weddingFirstPlatform = new Map<string, string>()
  for (const e of sortedEvents) {
    if (e.wedding_id && !weddingFirstPlatform.has(e.wedding_id)) {
      weddingFirstPlatform.set(e.wedding_id, normalisePlatform(e.source_platform))
    }
  }

  const recentByPlatform = new Map<string, number>()
  const trailingByPlatform = new Map<string, number>()
  const recentWeddings: string[] = []
  const trailingWeddings: string[] = []

  for (const w of dataset.weddings) {
    if (!w.inquiry_date) continue
    const t = Date.parse(w.inquiry_date)
    if (!Number.isFinite(t)) continue
    const platform = weddingFirstPlatform.get(w.id) ?? 'unknown'
    if (t >= recentCutoff) {
      recentByPlatform.set(platform, (recentByPlatform.get(platform) ?? 0) + 1)
      recentWeddings.push(w.id)
    } else if (t >= trailingCutoff) {
      trailingByPlatform.set(platform, (trailingByPlatform.get(platform) ?? 0) + 1)
      trailingWeddings.push(w.id)
    }
  }

  if (trailingWeddings.length < 30) {
    return buildHardRefusal(
      dataset,
      `Trailing 12-month window has only ${trailingWeddings.length} inquiries (need 30 for a stable comparison baseline).`,
    )
  }

  if (recentWeddings.length < 8) {
    return buildHardRefusal(
      dataset,
      `Most-recent 30 days has only ${recentWeddings.length} inquiries (need 8 to detect a meaningful share shift).`,
    )
  }

  const recentTotal = recentWeddings.length
  const trailingTotal = trailingWeddings.length

  // Compute per-platform share shift.
  const allPlatforms = new Set<string>([
    ...recentByPlatform.keys(),
    ...trailingByPlatform.keys(),
  ])
  const shifts: { platform: string; recent_pct: number; trailing_pct: number; delta_pct: number; recent_n: number }[] = []
  for (const p of allPlatforms) {
    const r = (recentByPlatform.get(p) ?? 0) / recentTotal * 100
    const t = (trailingByPlatform.get(p) ?? 0) / trailingTotal * 100
    shifts.push({
      platform: p,
      recent_pct: Math.round(r * 10) / 10,
      trailing_pct: Math.round(t * 10) / 10,
      delta_pct: Math.round((r - t) * 10) / 10,
      recent_n: recentByPlatform.get(p) ?? 0,
    })
  }
  shifts.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct))

  const topShifts = shifts.slice(0, 5)
  const bigShifts = shifts.filter((s) => Math.abs(s.delta_pct) >= 10)

  const cells = [
    makeFreeformCell({
      label: 'recent_30d_inquiries',
      n: recentTotal,
      headline_value: recentTotal,
      promptVersions: [],
      contributingWeddingIds: recentWeddings.slice(0, 50),
    }),
    makeFreeformCell({
      label: 'trailing_360d_inquiries',
      n: trailingTotal,
      headline_value: trailingTotal,
      promptVersions: [],
      contributingWeddingIds: trailingWeddings.slice(0, 50),
    }),
    makeFreeformCell({
      label: 'top_share_shifts',
      n: topShifts.length,
      headline_value: topShifts,
      promptVersions: [],
      contributingWeddingIds: [],
    }),
    makeFreeformCell({
      label: 'shifts_over_10pp',
      n: bigShifts.length,
      headline_value: bigShifts.map((s) => `${s.platform}: ${s.trailing_pct}% → ${s.recent_pct}% (Δ${s.delta_pct})`),
      promptVersions: [],
      contributingWeddingIds: [],
    }),
  ]

  const evidenceWeddings: EvidenceWedding[] = []
  for (const wid of recentWeddings) {
    if (evidenceWeddings.length >= 50) break
    const w = dataset.weddingById.get(wid)
    if (!w) continue
    const platform = weddingFirstPlatform.get(wid) ?? 'unknown'
    evidenceWeddings.push({
      wedding_id: wid,
      display_label: wid.slice(0, 8),
      annotation: `recent-30d · first-touch ${platform} · inquired ${w.inquiry_date?.slice(0, 10) ?? '?'}`,
      source_platform: platform,
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
    total_sample_size: recentTotal,
    confidence_level: deriveConfidenceLevel(cells.slice(0, 2)),
    min_sample_size: meta.default_min_sample_size,
    v1_contamination_pct: aggregateContaminationPct(cells),
    data_freshness_iso: dataset.data_freshness_iso,
    evidence_weddings: evidenceWeddings,
    context_notes: [
      `${recentTotal} inquiries in the last 30 days vs ${trailingTotal} in the preceding 360 days.`,
      `${bigShifts.length} platforms with > 10pp share shift between the windows.`,
      'First-touch platform derived from earliest attribution_events.decided_at per wedding.',
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
