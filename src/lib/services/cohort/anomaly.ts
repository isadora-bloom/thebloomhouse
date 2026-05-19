/**
 * D9 — couple-keyed anomaly detection.
 *
 * Flags months where inbound inquiry volume deviates sharply from the
 * venue's own baseline (z-score over the monthly series). This is the
 * couple-keyed successor to the legacy weddings-keyed anomaly pass:
 * the series is touchpoint inbound volume, not inquiry-row inserts.
 *
 * The most recent month is excluded — it is almost always partial and
 * would read as a false "drop".
 */

import type { CohortAnomaly, CohortData } from './types'
import { isOutbound } from './direction'
import { MONTH_LABEL, zonedParts } from './helpers'

const MIN_MONTHS = 6

export function computeAnomalies(data: CohortData): CohortAnomaly[] {
  const monthly = new Map<string, number>()
  for (const tp of data.touchpoints) {
    if (isOutbound(tp)) continue
    const p = zonedParts(tp.occurred_at, data.timezone)
    if (!p) continue
    monthly.set(p.monthKey, (monthly.get(p.monthKey) ?? 0) + 1)
  }

  const months = [...monthly.keys()].sort()
  if (months.length < MIN_MONTHS) return []

  // Drop the most recent (partial) month from the analysis.
  const analysed = months.slice(0, -1)
  if (analysed.length < MIN_MONTHS) return []

  const counts = analysed.map((m) => monthly.get(m) ?? 0)
  const mean = counts.reduce((s, v) => s + v, 0) / counts.length
  const variance =
    counts.reduce((s, v) => s + (v - mean) ** 2, 0) / counts.length
  const stdev = Math.sqrt(variance)

  if (stdev < 1) return [] // flat series — nothing to flag

  const anomalies: CohortAnomaly[] = []
  for (const m of analysed) {
    const observed = monthly.get(m) ?? 0
    const z = (observed - mean) / stdev
    if (Math.abs(z) < 2) continue
    const severity: CohortAnomaly['severity'] =
      Math.abs(z) >= 3 ? 'high' : Math.abs(z) >= 2.5 ? 'medium' : 'low'
    const dir = z > 0 ? 'spike' : 'drop'
    const [y, mm] = m.split('-')
    const label = `${MONTH_LABEL[Number(mm)]} ${y}`
    anomalies.push({
      metric: 'inbound_inquiry_volume',
      month: m,
      observed,
      expected: Math.round(mean),
      severity,
      note:
        `${label} saw ${observed} inbound inquiries — a ${dir} against a ` +
        `typical ${Math.round(mean)}/month (${z > 0 ? '+' : ''}${z.toFixed(1)}σ).`,
    })
  }
  return anomalies.sort((a, b) => b.month.localeCompare(a.month))
}
