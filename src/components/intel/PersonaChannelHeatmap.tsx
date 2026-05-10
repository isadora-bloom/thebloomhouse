'use client'

/**
 * Wave 6B — persona × channel ROI heatmap.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6B: the heatmap is the
 * dashboard's centerpiece; reveals "Knot brings Heritage-Forward at
 * $90 CAC at 22% conversion" while "Knot brings Cost-Conscious at $180
 * CAC at 3% conversion" — the disparity that channel-aggregate ROI
 * hides).
 *
 * Color scale: red (< 0.5x channel avg ROI) → yellow (0.5-1.5x) →
 * green (> 1.5x). n_too_small cells are neutral gray with "n < 10"
 * label so the operator never reads a misleading number from a
 * 2-wedding cohort.
 */

import { useMemo } from 'react'

export interface HeatmapCell {
  channel: string
  persona_label: string // includes '__untagged__' for NULL persona
  spend_cents: number
  inquiries_count: number
  booked_count: number
  cac_cents: number | null
  conversion_pct: number | null
  roi_pct: number | null
  n_too_small: boolean
  label: string | null
}

export interface PersonaChannelHeatmapProps {
  rollups: {
    personas: string[] // row order
    channels: string[] // col order
    cells: HeatmapCell[]
  }
  windowDays: number
}

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const dollars = cents / 100
  if (dollars >= 1000) {
    return `$${(dollars / 1000).toFixed(1)}k`
  }
  return `$${Math.round(dollars).toLocaleString()}`
}

function formatPct(pct: number | null): string {
  if (pct === null) return '—'
  return `${pct.toFixed(1)}%`
}

function formatPersonaLabel(p: string): string {
  if (p === '__untagged__') return 'Untagged'
  return p.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatChannelLabel(c: string): string {
  const map: Record<string, string> = {
    google_ads: 'Google Ads',
    meta_ads: 'Meta Ads',
    tiktok_ads: 'TikTok Ads',
    theknot_fee: 'The Knot',
    weddingwire_fee: 'WeddingWire',
    organic_seo: 'Organic SEO',
    vendor_referral: 'Vendor Referral',
    other: 'Other',
  }
  return (
    map[c] ??
    c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  )
}

/**
 * Color resolver. Returns a Tailwind background class chosen by ROI
 * relative to the channel average. n_too_small cells stay neutral gray.
 */
function cellColor(
  cell: HeatmapCell | null,
  channelAvgRoi: number | null,
): { bg: string; text: string } {
  if (!cell) return { bg: 'bg-stone-50', text: 'text-stone-300' }
  if (cell.n_too_small) return { bg: 'bg-stone-100', text: 'text-stone-500' }
  if (cell.roi_pct === null || channelAvgRoi === null || channelAvgRoi === 0) {
    return { bg: 'bg-white', text: 'text-stone-700' }
  }
  const ratio = cell.roi_pct / channelAvgRoi
  if (ratio >= 1.5) return { bg: 'bg-emerald-100', text: 'text-emerald-900' }
  if (ratio >= 1.0) return { bg: 'bg-emerald-50', text: 'text-emerald-800' }
  if (ratio >= 0.5) return { bg: 'bg-amber-50', text: 'text-amber-800' }
  return { bg: 'bg-rose-50', text: 'text-rose-800' }
}

export function PersonaChannelHeatmap({
  rollups,
  windowDays,
}: PersonaChannelHeatmapProps) {
  const { personas, channels, cells } = rollups

  // Index cells by (channel, persona) for O(1) lookup.
  const cellMap = useMemo(() => {
    const m = new Map<string, HeatmapCell>()
    for (const c of cells) {
      m.set(`${c.channel}::${c.persona_label}`, c)
    }
    return m
  }, [cells])

  // Channel-average ROI for color scaling. Computed over n_too_small=false
  // cells only — small-cohort cells should never anchor the color scale.
  const channelAvgRoi = useMemo(() => {
    const sums = new Map<string, { sum: number; count: number }>()
    for (const c of cells) {
      if (c.n_too_small || c.roi_pct === null) continue
      const acc = sums.get(c.channel) ?? { sum: 0, count: 0 }
      acc.sum += c.roi_pct
      acc.count += 1
      sums.set(c.channel, acc)
    }
    const out = new Map<string, number>()
    for (const [ch, { sum, count }] of sums.entries()) {
      out.set(ch, count > 0 ? sum / count : 0)
    }
    return out
  }, [cells])

  if (channels.length === 0 || personas.length === 0) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-6 text-center text-sm text-stone-500">
        No rollup data yet for the last {windowDays} days. Recompute or
        record some marketing spend first.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-xs font-semibold text-stone-600">
              Persona ↓ / Channel →
            </th>
            {channels.map((ch) => (
              <th
                key={ch}
                className="border-b border-stone-200 px-3 py-2 text-left text-xs font-semibold text-stone-700"
                style={{ minWidth: 140 }}
              >
                {formatChannelLabel(ch)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {personas.map((persona) => (
            <tr key={persona}>
              <td className="sticky left-0 z-10 bg-white border-r border-stone-200 px-3 py-2 text-xs font-medium text-stone-700">
                {formatPersonaLabel(persona)}
              </td>
              {channels.map((ch) => {
                const cell = cellMap.get(`${ch}::${persona}`) ?? null
                const avgRoi = channelAvgRoi.get(ch) ?? null
                const { bg, text } = cellColor(cell, avgRoi)
                return (
                  <td
                    key={`${persona}::${ch}`}
                    className={`border-b border-r border-stone-100 align-top ${bg}`}
                    style={{ minWidth: 140 }}
                  >
                    {cell ? (
                      <div className={`px-3 py-2 text-xs ${text}`}>
                        {cell.n_too_small ? (
                          <div className="text-stone-500">
                            n &lt; 10
                            <div className="text-[10px] text-stone-400 mt-0.5">
                              {cell.inquiries_count} inq · {cell.booked_count}{' '}
                              booked
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            <div className="font-semibold tabular-nums">
                              CAC {formatCents(cell.cac_cents)}
                            </div>
                            <div className="tabular-nums">
                              {formatPct(cell.conversion_pct)} conv
                            </div>
                            <div className="tabular-nums">
                              ROI {formatPct(cell.roi_pct)}
                            </div>
                            <div className="text-[10px] text-stone-500 mt-0.5">
                              {cell.inquiries_count} inq ·{' '}
                              {cell.booked_count} booked
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="px-3 py-2 text-xs text-stone-300">—</div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-stone-600">
        <span className="font-medium">Color scale (ROI vs channel avg):</span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded bg-emerald-100" />
          &gt; 1.5x (over-performer)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded bg-emerald-50" />
          1.0-1.5x
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded bg-amber-50" />
          0.5-1.0x
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded bg-rose-50" />
          &lt; 0.5x (under-performer)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded bg-stone-100" />
          n &lt; 10 (suppressed)
        </span>
      </div>
    </div>
  )
}
