'use client'

/**
 * /intel/source-quality - D8 per-channel quality scorecard (Tier 8 T8.2).
 *
 * One row per channel with: volume + booking rate + median response
 * time + median heat + match precision. Each cell carries its own n;
 * not-enough-data cells render dimmed instead of as a confident-
 * sounding zero.
 */

import { useEffect, useState, useCallback } from 'react'
import { ScanLine, Loader2, AlertCircle } from 'lucide-react'
import type { SourceQualityReport } from '@/lib/services/cohort/source-quality'

interface ApiResponse {
  ok: boolean
  venueName?: string
  report?: SourceQualityReport
  error?: string
}

function fmtPct(r: number | null): string {
  if (r === null) return '—'
  return `${Math.round(r * 100)}%`
}

function fmtScore(n: number | null): string {
  if (n === null) return '—'
  return Math.round(n).toString()
}

function fmtHours(h: number | null): string {
  if (h === null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

export default function SourceQualityPage() {
  const [data, setData] = useState<SourceQualityReport | null>(null)
  const [venueName, setVenueName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/source-quality', {
        cache: 'no-store',
      })
      const body: ApiResponse = await res.json()
      if (!body.ok || !body.report) {
        setError(body.error ?? 'Failed to load source quality')
      } else {
        setData(body.report)
        setVenueName(body.venueName ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900">
          Source quality
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Per-channel scorecard: volume, conversion, response time, heat,
          and match precision. Cells with n &lt; 8 are dimmed.
          {venueName ? ` · ${venueName}` : ''}
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sage-600 px-2 py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading source quality…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-900 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Could not load source quality</div>
            <div className="text-rose-700 mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {data && (
        <section className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-6 py-4 border-b border-border flex items-center gap-2">
            <ScanLine className="w-4 h-4 text-sage-500" />
            <h2 className="font-heading text-base font-semibold text-sage-900">
              Channel scorecard
            </h2>
          </div>
          <div className="px-6 py-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-sage-500 uppercase tracking-wide">
                <tr>
                  <th className="py-2">Channel</th>
                  <th className="py-2 text-right">Volume</th>
                  <th className="py-2 text-right">Booked</th>
                  <th className="py-2 text-right">Booking rate</th>
                  <th className="py-2 text-right">Median response</th>
                  <th className="py-2 text-right">Median heat</th>
                  <th className="py-2 text-right">Match precision</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={r.channel}
                    className="border-t border-border first:border-t-0"
                  >
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-medium ${r.isAcquisition ? 'text-sage-900' : 'text-sage-500'}`}
                        >
                          {r.channel}
                        </span>
                        {!r.isAcquisition && r.channel !== '(unknown_acquisition)' && (
                          <span className="text-[10px] text-sage-500 uppercase tracking-wide bg-sage-50 px-1.5 py-0.5 rounded">
                            plumbing
                          </span>
                        )}
                        {r.channel === '(unknown_acquisition)' && (
                          <span className="text-[10px] text-amber-800 uppercase tracking-wide bg-amber-50 px-1.5 py-0.5 rounded">
                            no first-touch
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 text-right">{r.volume.toLocaleString()}</td>
                    <td className="py-2 text-right">{r.booked.toLocaleString()}</td>
                    <td className={`py-2 text-right ${!r.enoughDataForBookingRate ? 'text-sage-400' : ''}`}>
                      {r.enoughDataForBookingRate ? fmtPct(r.bookingRate) : `n=${r.volume}`}
                    </td>
                    <td className={`py-2 text-right ${!r.enoughDataForResponse ? 'text-sage-400' : ''}`}>
                      {r.enoughDataForResponse ? fmtHours(r.medianResponseHours) : `n=${r.responseN}`}
                    </td>
                    <td className={`py-2 text-right ${!r.enoughDataForHeat ? 'text-sage-400' : ''}`}>
                      {r.enoughDataForHeat ? fmtScore(r.medianHeat) : `n=${r.heatN}`}
                    </td>
                    <td className={`py-2 text-right ${!r.enoughDataForPrecision ? 'text-sage-400' : ''}`}>
                      {r.enoughDataForPrecision ? fmtPct(r.matchPrecision) : `n=${r.matchN}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-sage-500 mt-3">
              Volume = couples whose first-touch (earliest acquisition-class
              inbound) is this channel. Match precision = share of candidate-
              merges keyed to this channel that you confirmed (vs rejected).
              Cells with n &lt; 8 surface their raw n so the metric is honest
              about how thin the sample is.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
