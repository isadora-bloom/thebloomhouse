'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Workflow,
  X,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from 'lucide-react'
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ZAxis,
} from 'recharts'
import { UpgradeGate } from '@/components/ui/upgrade-gate'

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CorrelationCell {
  xLabel: string
  yLabel: string
  correlation: number
  direction: 'positive' | 'negative' | 'neutral'
  strength: 'strong' | 'moderate' | 'weak' | 'none'
  xData: number[]
  yData: number[]
}

interface WeddingRow {
  id: string
  status: string
  booking_value: number | null
  source: string | null
  created_at: string
}

interface SocialPostRow {
  id: string
  reach: number
  likes: number
  comments: number
  posted_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return 0

  const xSlice = xs.slice(0, n)
  const ySlice = ys.slice(0, n)

  const meanX = xSlice.reduce((s, v) => s + v, 0) / n
  const meanY = ySlice.reduce((s, v) => s + v, 0) / n

  let num = 0
  let denX = 0
  let denY = 0
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - meanX
    const dy = ySlice[i] - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }

  const den = Math.sqrt(denX * denY)
  return den === 0 ? 0 : num / den
}

function correlationStrength(r: number): 'strong' | 'moderate' | 'weak' | 'none' {
  const abs = Math.abs(r)
  if (abs >= 0.7) return 'strong'
  if (abs >= 0.4) return 'moderate'
  if (abs >= 0.2) return 'weak'
  return 'none'
}

function correlationColor(strength: string, direction: string): string {
  if (strength === 'none') return 'bg-sage-50 text-sage-400'
  if (direction === 'positive') {
    if (strength === 'strong') return 'bg-emerald-100 text-emerald-800'
    if (strength === 'moderate') return 'bg-emerald-50 text-emerald-700'
    return 'bg-emerald-50/50 text-emerald-600'
  }
  if (strength === 'strong') return 'bg-red-100 text-red-800'
  if (strength === 'moderate') return 'bg-red-50 text-red-700'
  return 'bg-red-50/50 text-red-600'
}

function DirectionIcon({ direction, strength }: { direction: string; strength: string }) {
  if (strength === 'none') return <Minus className="w-3 h-3" />
  if (direction === 'positive') return <ArrowUpRight className="w-3 h-3" />
  return <ArrowDownRight className="w-3 h-3" />
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function CrossIntelligencePageInner() {
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [socialPosts, setSocialPosts] = useState<SocialPostRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedCell, setSelectedCell] = useState<CorrelationCell | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const [weddingRes, socialRes] = await Promise.all([
        supabase.from('weddings').select('id, status, booking_value, source, created_at').order('created_at'),
        supabase.from('social_posts').select('id, reach, likes, comments, posted_at').order('posted_at'),
      ])
      if (weddingRes.error) throw weddingRes.error
      if (socialRes.error) throw socialRes.error
      setWeddings((weddingRes.data ?? []) as WeddingRow[])
      setSocialPosts((socialRes.data ?? []) as SocialPostRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch cross-intelligence data:', err)
      setError('Failed to load cross-intelligence data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Build monthly aggregates for correlation
  const monthlyData = useMemo(() => {
    const months = new Map<string, {
      inquiries: number
      bookings: number
      revenue: number
      socialReach: number
      socialEngagement: number
    }>()

    for (const w of weddings) {
      const key = w.created_at.slice(0, 7) // YYYY-MM
      const m = months.get(key) ?? { inquiries: 0, bookings: 0, revenue: 0, socialReach: 0, socialEngagement: 0 }
      m.inquiries++
      if (['contracted', 'completed'].includes(w.status)) {
        m.bookings++
        m.revenue += w.booking_value ?? 0
      }
      months.set(key, m)
    }

    for (const sp of socialPosts) {
      const key = sp.posted_at.slice(0, 7)
      const m = months.get(key) ?? { inquiries: 0, bookings: 0, revenue: 0, socialReach: 0, socialEngagement: 0 }
      m.socialReach += sp.reach
      m.socialEngagement += sp.likes + sp.comments
      months.set(key, m)
    }

    return Array.from(months.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v)
  }, [weddings, socialPosts])

  // Correlation matrix
  const METRICS = [
    { key: 'socialReach', label: 'Social Reach' },
    { key: 'socialEngagement', label: 'Social Engagement' },
    { key: 'inquiries', label: 'Inquiries' },
    { key: 'bookings', label: 'Bookings' },
    { key: 'revenue', label: 'Revenue' },
  ]

  const correlationMatrix: CorrelationCell[][] = useMemo(() => {
    return METRICS.map((yMetric) =>
      METRICS.map((xMetric) => {
        const xData = monthlyData.map((d) => (d as Record<string, number>)[xMetric.key])
        const yData = monthlyData.map((d) => (d as Record<string, number>)[yMetric.key])
        const r = computeCorrelation(xData, yData)
        const strength = correlationStrength(r)
        const direction = r > 0.1 ? 'positive' : r < -0.1 ? 'negative' : 'neutral'
        return {
          xLabel: xMetric.label,
          yLabel: yMetric.label,
          correlation: r,
          direction,
          strength,
          xData,
          yData,
        }
      })
    )
  }, [monthlyData])

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Cross-Intelligence Correlations
        </h1>
        <p className="text-sage-600">
          Discover how social media activity, inquiry volume, bookings, and revenue move together. The correlation matrix reveals which efforts actually drive results — and which don't.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Workflow className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="bg-surface border border-border rounded-xl p-8 shadow-sm">
          <div className="animate-pulse space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-2">
                {Array.from({ length: 5 }).map((_, j) => (
                  <div key={j} className="h-12 w-full bg-sage-100 rounded" />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : monthlyData.length < 3 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Workflow className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            Not enough data
          </h3>
          <p className="text-sm text-sage-600">
            At least 3 months of data are needed to compute meaningful correlations.
          </p>
        </div>
      ) : (
        <>
          {/* Correlation heatmap */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">
              Correlation Matrix
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="p-2 text-xs font-medium text-sage-500" />
                    {METRICS.map((m) => (
                      <th key={m.key} className="p-2 text-xs font-medium text-sage-600 text-center">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {correlationMatrix.map((row, yi) => (
                    <tr key={METRICS[yi].key}>
                      <td className="p-2 text-xs font-medium text-sage-600 whitespace-nowrap">
                        {METRICS[yi].label}
                      </td>
                      {row.map((cell, xi) => {
                        const isDiagonal = xi === yi
                        return (
                          <td key={`${xi}-${yi}`} className="p-1">
                            {isDiagonal ? (
                              <div className="h-12 rounded-lg bg-sage-100 flex items-center justify-center text-xs text-sage-400">
                                1.00
                              </div>
                            ) : (
                              <button
                                onClick={() => setSelectedCell(cell)}
                                className={`w-full h-12 rounded-lg flex flex-col items-center justify-center text-xs font-semibold transition-all hover:ring-2 hover:ring-sage-300 ${correlationColor(cell.strength, cell.direction)}`}
                              >
                                <DirectionIcon direction={cell.direction} strength={cell.strength} />
                                {cell.correlation.toFixed(2)}
                              </button>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="mt-4 flex flex-wrap gap-3 text-xs text-sage-500">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100" /> Strong positive</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-50" /> Moderate positive</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-sage-50" /> None</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-50" /> Moderate negative</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100" /> Strong negative</span>
            </div>
          </div>

          {/* Scatter plot drawer */}
          {selectedCell && (
            <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h2 className="font-heading text-lg font-semibold text-sage-900">
                  {selectedCell.yLabel} vs {selectedCell.xLabel}
                  <span className={`ml-2 text-sm font-normal ${
                    selectedCell.direction === 'positive' ? 'text-emerald-600' :
                    selectedCell.direction === 'negative' ? 'text-red-600' : 'text-sage-500'
                  }`}>
                    r = {selectedCell.correlation.toFixed(3)} ({selectedCell.strength})
                  </span>
                </h2>
                <button
                  onClick={() => setSelectedCell(null)}
                  className="p-1.5 rounded-lg hover:bg-sage-50 transition-colors"
                >
                  <X className="w-4 h-4 text-sage-500" />
                </button>
              </div>
              <div className="p-6">
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 4, right: 16, bottom: 20, left: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" />
                      <XAxis
                        dataKey="x"
                        type="number"
                        name={selectedCell.xLabel}
                        tick={{ fontSize: 11, fill: '#6A7060' }}
                        tickLine={false}
                        axisLine={false}
                        label={{ value: selectedCell.xLabel, position: 'bottom', offset: 0, fontSize: 11, fill: '#6A7060' }}
                      />
                      <YAxis
                        dataKey="y"
                        type="number"
                        name={selectedCell.yLabel}
                        tick={{ fontSize: 11, fill: '#6A7060' }}
                        tickLine={false}
                        axisLine={false}
                        label={{ value: selectedCell.yLabel, angle: -90, position: 'left', offset: 0, fontSize: 11, fill: '#6A7060' }}
                      />
                      <ZAxis range={[40, 40]} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#FFF', border: '1px solid #E8E4DF', borderRadius: '8px', fontSize: '13px' }}
                        formatter={(v, name) => { const n = Number(v) || 0; return [n.toFixed(1), String(name)]; }}
                      />
                      <Scatter
                        name="Data"
                        data={selectedCell.xData.map((x, i) => ({
                          x,
                          y: selectedCell.yData[i] ?? 0,
                        }))}
                        fill="#7D8471"
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function CrossIntelligencePageWrapper() {
  return (
    <UpgradeGate requiredTier="enterprise" featureName="Venue Comparison">
      <CrossIntelligencePageInner />
    </UpgradeGate>
  )
}
