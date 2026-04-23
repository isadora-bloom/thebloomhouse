'use client'

/**
 * Marketing Reach — surfaces every marketing_metric the brain-dump has
 * ingested from screenshots (Knot visitor charts, Instagram follower
 * counts, Pinterest saves, Google Analytics sessions, etc).
 *
 * Data source: engagement_events where event_type='marketing_metric'.
 * Served by /api/intel/reach grouped by (source, metric).
 */

import { useCallback, useEffect, useState } from 'react'
import { BarChart3, TrendingUp, Camera, Loader2 } from 'lucide-react'

interface ReachGroup {
  source: string
  metric: string
  total: number
  latest: number | null
  points: Array<{ label: string; value: number }>
}

const SOURCE_LABELS: Record<string, string> = {
  the_knot: 'The Knot',
  wedding_wire: 'WeddingWire',
  google: 'Google',
  google_analytics: 'Google Analytics',
  google_business: 'Google Business',
  instagram: 'Instagram',
  facebook: 'Facebook',
  pinterest: 'Pinterest',
  tiktok: 'TikTok',
  website: 'Website',
  honeybook: 'HoneyBook',
  email: 'Email',
  other: 'Other',
}

const METRIC_LABELS: Record<string, string> = {
  unique_visitors: 'Unique visitors',
  page_views: 'Page views',
  sessions: 'Sessions',
  leads: 'Leads',
  inquiries: 'Inquiries',
  likes: 'Likes',
  followers: 'Followers',
  saves: 'Saves',
  engagement_rate: 'Engagement rate',
  impressions: 'Impressions',
  reach: 'Reach',
  clicks: 'Clicks',
  ctr: 'Click-through rate',
  spend: 'Spend',
  other: 'Other',
}

function humanSource(s: string) { return SOURCE_LABELS[s] ?? s }
function humanMetric(m: string) { return METRIC_LABELS[m] ?? m }

function Sparkline({ points }: { points: Array<{ label: string; value: number }> }) {
  if (points.length === 0) return null
  const width = 200
  const height = 40
  const pad = 2
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = (width - 2 * pad) / Math.max(1, points.length - 1)
  const yFor = (v: number) => height - pad - ((v - min) / range) * (height - 2 * pad)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * stepX},${yFor(p.value)}`).join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={d} fill="none" stroke="#7D8471" strokeWidth="1.5" />
      {points.map((p, i) => (
        <circle key={i} cx={pad + i * stepX} cy={yFor(p.value)} r={2.5} fill="#7D8471" />
      ))}
    </svg>
  )
}

export default function ReachPage() {
  const [groups, setGroups] = useState<ReachGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/intel/reach')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { groups: ReachGroup[] }
      setGroups(data.groups ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reach metrics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const bySource = new Map<string, ReachGroup[]>()
  for (const g of groups) {
    const list = bySource.get(g.source) ?? []
    list.push(g)
    bySource.set(g.source, list)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold text-sage-900 flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-sage-600" />
          Marketing Reach
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Every platform metric Bloom has ingested. Drop screenshots into the &quot;Tell Sage something&quot; button and they land here, grouped by platform.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sage-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading reach data...
        </div>
      ) : error ? (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700">
          {error}
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-sage-50 border border-sage-200 rounded-xl p-8 text-center">
          <Camera className="w-8 h-8 text-sage-400 mx-auto mb-3" />
          <p className="text-sage-800 font-medium mb-1">No reach data yet.</p>
          <p className="text-sm text-sage-500 max-w-md mx-auto">
            Drop a screenshot of any platform dashboard (The Knot analytics, Instagram insights, Google Analytics, Pinterest, Facebook, etc.) into the &quot;Tell Sage something&quot; button. Bloom will extract the numbers and track them here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(bySource.entries()).map(([source, list]) => (
            <div key={source} className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-heading text-lg font-semibold text-sage-900 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-sage-600" />
                  {humanSource(source)}
                </h2>
                <span className="text-xs text-sage-500">
                  {list.length} metric{list.length === 1 ? '' : 's'} tracked
                </span>
              </div>
              <div className="space-y-4">
                {list.map((g) => (
                  <div key={`${g.source}-${g.metric}`} className="flex items-center justify-between gap-4 border-t border-sage-100 pt-4 first:border-t-0 first:pt-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-sage-900">{humanMetric(g.metric)}</p>
                      <p className="text-xs text-sage-500 mt-0.5">
                        {g.points.length} data point{g.points.length === 1 ? '' : 's'}
                        <span> · </span>
                        total {g.total.toLocaleString()}
                        {g.latest != null && (
                          <>
                            <span> · </span>
                            latest {g.latest.toLocaleString()}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <Sparkline points={g.points} />
                      <div className="hidden md:flex items-center gap-1 text-xs text-sage-500">
                        {g.points.slice(-4).map((p) => (
                          <span key={p.label} className="bg-sage-50 border border-sage-100 rounded px-1.5 py-0.5">
                            {p.label}: {p.value.toLocaleString()}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
