'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  BarChart3,
  AlertTriangle,
  Check,
  X,
  Lightbulb,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrendPoint {
  id: string
  venue_id: string
  metro: string
  term: string
  week: string
  interest: number
  created_at: string
}

interface TrendDeviation {
  term: string
  category: 'core' | 'leading' | 'dampener'
  recentAvg: number
  priorAvg: number
  changePercent: number
  direction: 'up' | 'down'
}

interface TrendRecommendation {
  id: string
  venue_id: string
  recommendation_type: string
  title: string
  body: string | null
  data_source: string | null
  supporting_data: Record<string, unknown>
  priority: string | number
  status: 'pending' | 'applied' | 'dismissed'
  applied_at: string | null
  dismissed_at: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByTerm(trends: TrendPoint[]): Record<string, TrendPoint[]> {
  const grouped: Record<string, TrendPoint[]> = {}
  for (const point of trends) {
    if (!grouped[point.term]) grouped[point.term] = []
    grouped[point.term].push(point)
  }
  // Sort each group by week ascending
  for (const term in grouped) {
    grouped[term].sort((a, b) => a.week.localeCompare(b.week))
  }
  return grouped
}

function formatWeekLabel(week: string): string {
  const d = new Date(week + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function categoryColor(category: string): string {
  switch (category) {
    case 'core':
      return 'bg-sage-100 text-sage-700'
    case 'leading':
      return 'bg-teal-100 text-teal-700'
    case 'dampener':
      return 'bg-gold-100 text-gold-700'
    default:
      return 'bg-sage-100 text-sage-600'
  }
}

function priorityColor(priority: string | number): string {
  const p = typeof priority === 'number' ? priority : priority
  if (p === 1 || p === 'high') return 'bg-gold-100 text-gold-700'
  if (p === 2 || p === 'medium') return 'bg-teal-100 text-teal-700'
  return 'bg-sage-100 text-sage-600'
}

function priorityLabel(priority: string | number): string {
  if (priority === 1 || priority === 'high') return 'High'
  if (priority === 2 || priority === 'medium') return 'Medium'
  if (priority === 3 || priority === 'low') return 'Low'
  return String(priority)
}

function statusBadge(status: string): { className: string; label: string } {
  switch (status) {
    case 'applied':
      return { className: 'bg-teal-100 text-teal-700', label: 'Applied' }
    case 'dismissed':
      return { className: 'bg-sage-100 text-sage-500', label: 'Dismissed' }
    default:
      return { className: 'bg-gold-100 text-gold-700', label: 'Pending' }
  }
}

// ---------------------------------------------------------------------------
// Skeleton Loader
// ---------------------------------------------------------------------------

function SkeletonCard() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="h-4 bg-sage-100 rounded w-2/3" />
        <div className="h-32 bg-sage-100 rounded" />
        <div className="flex gap-2">
          <div className="h-4 bg-sage-100 rounded w-16" />
          <div className="h-4 bg-sage-100 rounded w-12" />
        </div>
      </div>
    </div>
  )
}

function SkeletonRow() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-4 bg-sage-100 rounded w-3/4" />
        <div className="h-3 bg-sage-100 rounded w-full" />
        <div className="h-3 bg-sage-100 rounded w-1/2" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Trend Chart Card
// ---------------------------------------------------------------------------

function TrendChartCard({ term, points }: { term: string; points: TrendPoint[] }) {
  const latest = points[points.length - 1]
  const previous = points.length >= 2 ? points[points.length - 2] : null
  const trending = previous ? latest.interest >= previous.interest : true

  const chartData = points.map((p) => ({
    week: formatWeekLabel(p.week),
    interest: p.interest,
  }))

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-start justify-between mb-4">
        <h3 className="font-heading text-base font-semibold text-sage-900 capitalize">
          {term}
        </h3>
        <div className="flex items-center gap-1.5">
          <span className="text-lg font-bold text-sage-900">{latest.interest}</span>
          {trending ? (
            <ArrowUpRight className="w-4 h-4 text-teal-500" />
          ) : (
            <ArrowDownRight className="w-4 h-4 text-heat-hot" />
          )}
        </div>
      </div>

      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <defs>
              <linearGradient id={`gradient-${term.replace(/\s+/g, '-')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#C1C7BB" stopOpacity={0.6} />
                <stop offset="95%" stopColor="#C1C7BB" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
            <XAxis
              dataKey="week"
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#6A7060' }}
              tickLine={false}
              axisLine={false}
              domain={[0, 100]}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#FFFFFF',
                border: '1px solid #E8E4DF',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              labelStyle={{ color: '#31342D', fontWeight: 600 }}
            />
            <Area
              type="monotone"
              dataKey="interest"
              stroke="#7D8471"
              strokeWidth={2}
              fill={`url(#gradient-${term.replace(/\s+/g, '-')})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-3 text-xs text-sage-500">
        {points.length} week{points.length !== 1 ? 's' : ''} of data
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deviation Card
// ---------------------------------------------------------------------------

function DeviationCard({ deviation }: { deviation: TrendDeviation }) {
  const isUp = deviation.direction === 'up'

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm flex gap-4 items-start">
      <div
        className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
          isUp ? 'bg-teal-100' : 'bg-heat-hot/10'
        }`}
      >
        {isUp ? (
          <TrendingUp className="w-5 h-5 text-teal-500" />
        ) : (
          <TrendingDown className="w-5 h-5 text-heat-hot" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="font-heading text-base font-semibold text-sage-900 capitalize">
            {deviation.term}
          </h4>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${categoryColor(
              deviation.category
            )}`}
          >
            {deviation.category}
          </span>
        </div>

        <p className="text-sm text-sage-600 mt-1">
          <span className={`font-semibold ${isUp ? 'text-teal-500' : 'text-heat-hot'}`}>
            {isUp ? '+' : ''}
            {deviation.changePercent}%
          </span>{' '}
          change &mdash; recent avg {deviation.recentAvg} vs prior avg {deviation.priorAvg}
        </p>

        <p className="text-xs text-sage-500 mt-1">
          {deviation.category === 'core' && isUp && 'Direct wedding demand is rising in your market.'}
          {deviation.category === 'core' && !isUp && 'Direct wedding demand is softening. Consider proactive outreach.'}
          {deviation.category === 'leading' && isUp && 'Early indicator of future demand surge (3-12 month lag).'}
          {deviation.category === 'leading' && !isUp && 'Leading indicator is cooling. Plan for a potential slowdown.'}
          {deviation.category === 'dampener' && isUp && 'Market dampener is rising. Diversify event types or strengthen retention.'}
          {deviation.category === 'dampener' && !isUp && 'Dampener signal is receding. Market conditions may be stabilizing.'}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recommendation Card
// ---------------------------------------------------------------------------

function RecommendationCard({
  rec,
  onApply,
  onDismiss,
}: {
  rec: TrendRecommendation
  onApply: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const badge = statusBadge(rec.status)

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-gold-100 flex items-center justify-center">
          <Lightbulb className="w-5 h-5 text-gold-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h4 className="font-heading text-base font-semibold text-sage-900">
              {rec.title}
            </h4>
          </div>

          <div className="flex items-center gap-2 flex-wrap mb-2">
            {rec.data_source && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sage-100 text-sage-600">
                {rec.data_source}
              </span>
            )}
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${priorityColor(
                rec.priority
              )}`}
            >
              {priorityLabel(rec.priority)}
            </span>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${badge.className}`}
            >
              {badge.label}
            </span>
            {rec.recommendation_type && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 capitalize">
                {rec.recommendation_type}
              </span>
            )}
          </div>

          {rec.body && (
            <p className="text-sm text-sage-600 leading-relaxed">{rec.body}</p>
          )}

          {/* Supporting data toggle */}
          {rec.supporting_data &&
            Object.keys(rec.supporting_data).length > 0 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="mt-3 flex items-center gap-1 text-xs text-sage-500 hover:text-sage-700 transition-colors"
              >
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform ${
                    expanded ? 'rotate-90' : ''
                  }`}
                />
                Supporting data
              </button>
            )}

          {expanded && (
            <div className="mt-2 bg-sage-50 rounded-lg p-3 text-xs text-sage-600 overflow-x-auto">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(rec.supporting_data, null, 2)}
              </pre>
            </div>
          )}

          {/* Actions for pending */}
          {rec.status === 'pending' && (
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => onApply(rec.id)}
                className="inline-flex items-center gap-1.5 bg-sage-500 hover:bg-sage-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
              >
                <Check className="w-4 h-4" />
                Apply
              </button>
              <button
                onClick={() => onDismiss(rec.id)}
                className="inline-flex items-center gap-1.5 border border-sage-300 text-sage-700 hover:bg-sage-50 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
              >
                <X className="w-4 h-4" />
                Dismiss
              </button>
            </div>
          )}

          {/* Applied / Dismissed timestamps */}
          {rec.status === 'applied' && rec.applied_at && (
            <p className="mt-3 text-xs text-sage-400">
              Applied {new Date(rec.applied_at).toLocaleDateString()}
            </p>
          )}
          {rec.status === 'dismissed' && rec.dismissed_at && (
            <p className="mt-3 text-xs text-sage-400">
              Dismissed {new Date(rec.dismissed_at).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function TrendsPage() {
  const [data, setData] = useState<{
    trends: TrendPoint[]
    deviations: TrendDeviation[]
  } | null>(null)
  const [recommendations, setRecommendations] = useState<TrendRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Fetch trends + deviations
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/intel/trends')
      if (!res.ok) throw new Error(`Failed to fetch trends (${res.status})`)
      const json = await res.json()
      setData(json)
      setLastUpdated(new Date())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trends')
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch recommendations
  const fetchRecommendations = useCallback(async () => {
    try {
      const res = await fetch('/api/intel/recommendations')
      if (!res.ok) return // endpoint may not exist yet
      const json = await res.json()
      if (Array.isArray(json.recommendations)) {
        setRecommendations(json.recommendations)
      }
    } catch {
      // Silently ignore — recommendations may not be available yet
    }
  }, [])

  useEffect(() => {
    fetchData()
    fetchRecommendations()
  }, [fetchData, fetchRecommendations])

  // Trigger manual refresh
  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/intel/trends', { method: 'POST' })
      if (!res.ok) throw new Error(`Refresh failed (${res.status})`)
      // Re-fetch data after refresh
      await fetchData()
      await fetchRecommendations()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  // Update recommendation status
  const updateRecommendation = async (id: string, status: 'applied' | 'dismissed') => {
    try {
      const res = await fetch('/api/intel/recommendations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      })
      if (!res.ok) throw new Error(`Update failed (${res.status})`)
      // Optimistic update
      setRecommendations((prev) =>
        prev.map((r) =>
          r.id === id
            ? {
                ...r,
                status,
                applied_at: status === 'applied' ? new Date().toISOString() : r.applied_at,
                dismissed_at: status === 'dismissed' ? new Date().toISOString() : r.dismissed_at,
              }
            : r
        )
      )
    } catch {
      // Re-fetch to get correct state
      await fetchRecommendations()
    }
  }

  const grouped = data ? groupByTerm(data.trends) : {}
  const termNames = Object.keys(grouped).sort()
  const deviations = data?.deviations ?? []
  const pendingRecs = recommendations.filter((r) => r.status === 'pending')
  const resolvedRecs = recommendations.filter((r) => r.status !== 'pending')

  // ---- Compute insights from trend data ----
  const trendInsights: InsightItem[] = (() => {
    if (!data || deviations.length === 0) return []
    const items: InsightItem[] = []

    // Rising terms — biggest positive change
    const rising = deviations.filter((d) => d.direction === 'up').sort((a, b) => b.changePercent - a.changePercent)
    if (rising.length > 0) {
      const top = rising[0]
      items.push({
        icon: 'trend_up',
        text: `"${top.term}" searches are up ${top.changePercent}% — feature this in your content and social media`,
        priority: 'high',
      })
    }

    // Falling terms — biggest negative change
    const falling = deviations.filter((d) => d.direction === 'down').sort((a, b) => a.changePercent - b.changePercent)
    if (falling.length > 0) {
      const top = falling[0]
      items.push({
        icon: 'trend_down',
        text: `"${top.term}" interest is declining (${top.changePercent}%) — diversify your positioning away from this term`,
        priority: 'medium',
      })
    }

    // Seasonal insight from core vs dampener signals
    const coreUp = deviations.filter((d) => d.category === 'core' && d.direction === 'up').length
    const coreDown = deviations.filter((d) => d.category === 'core' && d.direction === 'down').length
    if (coreUp > coreDown) {
      items.push({
        icon: 'tip',
        text: 'Based on search patterns, demand signals are strengthening in your region — a good time to promote availability',
      })
    } else if (coreDown > coreUp) {
      items.push({
        icon: 'warning',
        text: 'Based on search patterns, demand signals are softening in your region — focus on lead nurturing and retention',
        priority: 'medium',
      })
    }

    return items
  })()

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Trends & Recommendations
          </h1>
          <p className="text-sage-600 text-sm">
            AI-analyzed trends from Google search data, seasonal patterns, and your own booking history. Each trend comes with a specific recommendation you can act on.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-sage-400">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh Trends'}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Error State                                                         */}
      {/* ------------------------------------------------------------------ */}
      {error && (
        <div className="bg-heat-hot/5 border border-heat-hot/20 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-heat-hot flex-shrink-0" />
          <p className="text-sm text-sage-900">{error}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* AI Insights                                                          */}
      {/* ------------------------------------------------------------------ */}
      {!loading && trendInsights.length > 0 && (
        <InsightPanel insights={trendInsights} />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Loading State                                                       */}
      {/* ------------------------------------------------------------------ */}
      {loading && (
        <>
          <section>
            <h2 className="font-heading text-xl font-bold text-sage-900 mb-4 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-sage-400" />
              Search Trend Charts
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          </section>

          <section>
            <h2 className="font-heading text-xl font-bold text-sage-900 mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-sage-400" />
              Trend Deviations
            </h2>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          </section>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Loaded State — No Data                                              */}
      {/* ------------------------------------------------------------------ */}
      {!loading && data && termNames.length === 0 && deviations.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <BarChart3 className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No trend data yet
          </h3>
          <p className="text-sm text-sage-500 max-w-md mx-auto">
            Click &ldquo;Refresh Trends&rdquo; to fetch Google Trends data for your market area.
            Make sure your venue has a metro region configured.
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Search Trend Charts                                                 */}
      {/* ------------------------------------------------------------------ */}
      {!loading && termNames.length > 0 && (
        <section>
          <h2 className="font-heading text-xl font-bold text-sage-900 mb-4 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-sage-400" />
            Search Trend Charts
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {termNames.map((term) => (
              <TrendChartCard key={term} term={term} points={grouped[term]} />
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Trend Deviations                                                    */}
      {/* ------------------------------------------------------------------ */}
      {!loading && deviations.length > 0 && (
        <section>
          <h2 className="font-heading text-xl font-bold text-sage-900 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-gold-500" />
            Trend Deviations
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gold-100 text-gold-700">
              {deviations.length}
            </span>
          </h2>
          <div className="space-y-3">
            {deviations.map((d) => (
              <DeviationCard key={d.term} deviation={d} />
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Active Recommendations                                              */}
      {/* ------------------------------------------------------------------ */}
      {!loading && recommendations.length > 0 && (
        <section>
          <h2 className="font-heading text-xl font-bold text-sage-900 mb-4 flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-gold-500" />
            Recommendations
            {pendingRecs.length > 0 && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gold-100 text-gold-700">
                {pendingRecs.length} pending
              </span>
            )}
          </h2>

          {/* Pending recommendations first */}
          {pendingRecs.length > 0 && (
            <div className="space-y-3 mb-6">
              {pendingRecs.map((rec) => (
                <RecommendationCard
                  key={rec.id}
                  rec={rec}
                  onApply={(id) => updateRecommendation(id, 'applied')}
                  onDismiss={(id) => updateRecommendation(id, 'dismissed')}
                />
              ))}
            </div>
          )}

          {/* Resolved recommendations */}
          {resolvedRecs.length > 0 && (
            <>
              {pendingRecs.length > 0 && (
                <h3 className="text-sm font-medium text-sage-500 mb-3 mt-6">
                  Previous recommendations
                </h3>
              )}
              <div className="space-y-3 opacity-75">
                {resolvedRecs.map((rec) => (
                  <RecommendationCard
                    key={rec.id}
                    rec={rec}
                    onApply={(id) => updateRecommendation(id, 'applied')}
                    onDismiss={(id) => updateRecommendation(id, 'dismissed')}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}
