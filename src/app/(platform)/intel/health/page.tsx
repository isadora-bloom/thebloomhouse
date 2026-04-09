'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Activity,
  Database,
  Clock,
  Target,
  TrendingUp,
  Lightbulb,
} from 'lucide-react'
import { useScope, scopeVenueFilter } from '@/lib/hooks/use-scope'
import { computeHealthBreakdown } from '@/lib/intel/health-score'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

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

interface WeddingRow {
  id: string
  venue_id: string
  status: string
  booking_value: number | null
  source: string | null
  inquiry_date: string | null
  created_at: string
}

interface InteractionRow {
  venue_id: string
  direction: string
  timestamp: string
}

interface VenueHealthHistoryRow {
  venue_id: string
  overall_score: number | null
  calculated_at: string
}

interface Recommendation {
  dimension: string
  score: number
  message: string
  icon: React.ComponentType<{ className?: string }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score > 70) return 'text-emerald-500'
  if (score > 40) return 'text-amber-500'
  return 'text-red-500'
}

function scoreBg(score: number): string {
  if (score > 70) return 'bg-emerald-50 border-emerald-200'
  if (score > 40) return 'bg-amber-50 border-amber-200'
  return 'bg-red-50 border-red-200'
}

function scoreStroke(score: number): string {
  if (score > 70) return '#10B981'
  if (score > 40) return '#F59E0B'
  return '#EF4444'
}

// ---------------------------------------------------------------------------
// Large Health Ring
// ---------------------------------------------------------------------------

function LargeHealthRing({ score }: { score: number }) {
  const size = 200
  const strokeWidth = 12
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  const color = scoreColor(score)

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#E8E4DF"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={color}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-4xl font-bold ${color}`}>{score}</span>
        <span className="text-xs text-sage-500 mt-1">out of 100</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dimension Card
// ---------------------------------------------------------------------------

function DimensionCard({
  icon: Icon,
  label,
  score,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  score: number
}) {
  const barWidth = `${Math.min(score, 100)}%`
  return (
    <div className={`border rounded-xl p-5 ${scoreBg(score)}`}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`w-4 h-4 ${scoreColor(score)}`} />
        <span className="text-sm font-medium text-sage-700">{label}</span>
        <span className={`ml-auto text-lg font-bold ${scoreColor(score)}`}>{score}</span>
      </div>
      <div className="h-2 bg-white/60 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: barWidth,
            backgroundColor: scoreStroke(score),
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function HealthSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex justify-center">
        <div className="w-[200px] h-[200px] bg-sage-100 rounded-full animate-pulse" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-5 animate-pulse">
            <div className="h-4 w-24 bg-sage-100 rounded mb-3" />
            <div className="h-2 bg-sage-50 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function HealthDashboardPage() {
  const scope = useScope()
  const scopedVenueIds = scopeVenueFilter(scope)
  const scopeKey = JSON.stringify(scopedVenueIds)

  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [interactions, setInteractions] = useState<InteractionRow[]>([])
  const [healthHistoryRows, setHealthHistoryRows] = useState<VenueHealthHistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const ninetyDaysAgo = new Date()
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

      let weddingQ = supabase
        .from('weddings')
        .select('id, venue_id, status, booking_value, source, inquiry_date, created_at')
      let interactionQ = supabase
        .from('interactions')
        .select('venue_id, direction, timestamp')
        .gte('timestamp', ninetyDaysAgo.toISOString())
        .order('timestamp', { ascending: true })
      let healthQ = supabase
        .from('venue_health')
        .select('venue_id, overall_score, calculated_at')
        .order('calculated_at', { ascending: true })

      const ids: string[] | null = JSON.parse(scopeKey)
      if (ids) {
        weddingQ = weddingQ.in('venue_id', ids)
        interactionQ = interactionQ.in('venue_id', ids)
        healthQ = healthQ.in('venue_id', ids)
      }

      const [wRes, iRes, hRes] = await Promise.all([weddingQ, interactionQ, healthQ])
      if (wRes.error) throw wRes.error
      if (iRes.error) throw iRes.error
      if (hRes.error) throw hRes.error

      setWeddings((wRes.data ?? []) as WeddingRow[])
      setInteractions((iRes.data ?? []) as InteractionRow[])
      setHealthHistoryRows((hRes.data ?? []) as VenueHealthHistoryRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch health data:', err)
      setError('Failed to load health data')
    } finally {
      setLoading(false)
    }
  }, [scopeKey])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Compute inputs to the health formula from real data ----
  const metrics = useMemo(() => {
    const bookedStatuses = ['booked', 'contracted', 'completed']
    const lostStatuses = ['lost', 'cancelled', 'closed_lost']

    const totalLeads = weddings.length

    const bookedCount = weddings.filter((w) => bookedStatuses.includes(w.status)).length
    const bookingConversionRate: number | null =
      totalLeads > 0 ? bookedCount / totalLeads : null

    // Response time (minutes): avg inbound → next outbound per venue
    const sortedInt = [...interactions].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )
    const inbound = sortedInt.filter((i) => i.direction === 'inbound')
    const outbound = sortedInt.filter((i) => i.direction === 'outbound')
    const gapsMinutes: number[] = []
    for (const ib of inbound) {
      const reply = outbound.find(
        (ob) =>
          ob.venue_id === ib.venue_id &&
          new Date(ob.timestamp).getTime() > new Date(ib.timestamp).getTime()
      )
      if (reply) {
        const mins =
          (new Date(reply.timestamp).getTime() - new Date(ib.timestamp).getTime()) / 60000
        if (mins < 72 * 60) gapsMinutes.push(mins)
      }
    }
    const responseTimeMinutes: number | null =
      gapsMinutes.length > 0
        ? gapsMinutes.reduce((a, b) => a + b, 0) / gapsMinutes.length
        : null

    // Source diversity
    const sources = new Set(
      weddings.map((w) => w.source).filter((s): s is string => !!s && s.trim() !== '')
    )
    const sourceCount: number | null = sources.size > 0 ? sources.size : null

    // Booking pace: last 30d bookings vs target = totalLeads * (30/90)
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const recentBooked = weddings.filter(
      (w) =>
        bookedStatuses.includes(w.status) &&
        new Date(w.inquiry_date ?? w.created_at) >= thirtyDaysAgo
    ).length
    const target = totalLeads * (30 / 90)
    const bookingPace: number | null =
      totalLeads > 0 && target > 0 ? Math.min(1, recentBooked / target) : null

    // Pipeline: non-lost fraction
    const active = weddings.filter((w) => !lostStatuses.includes(w.status)).length
    const pipelineActiveRatio: number | null =
      totalLeads > 0 ? active / totalLeads : null

    // Data completeness: fraction of (booking_value, source) fields filled
    let dataCompleteness: number | null = null
    if (totalLeads > 0) {
      let filled = 0
      let total = 0
      for (const w of weddings) {
        total += 2
        if (w.booking_value != null) filled += 1
        if (w.source && w.source.trim() !== '') filled += 1
      }
      dataCompleteness = total > 0 ? filled / total : null
    }

    // No reviews table wired in yet — keep null (do NOT default to 100)
    const avgReviewRating: number | null = null

    return {
      bookingConversionRate,
      responseTimeMinutes,
      avgReviewRating,
      sourceCount,
      bookingPace,
      pipelineActiveRatio,
      dataCompleteness,
    }
  }, [weddings, interactions])

  const breakdown = useMemo(() => computeHealthBreakdown(metrics), [metrics])

  const hasAnyData =
    breakdown.overall != null ||
    breakdown.dataQuality != null ||
    breakdown.pipelineHealth != null ||
    breakdown.responseTime != null ||
    breakdown.bookingRate != null

  const overallScore = breakdown.overall ?? 0
  const dataQuality = breakdown.dataQuality ?? 0
  const pipelineHealth = breakdown.pipelineHealth ?? 0
  const responseTime = breakdown.responseTime ?? 0
  const bookingRate = breakdown.bookingRate ?? 0

  // Historical (last 12 weeks) — from stored venue_health rows
  const historyData = useMemo(() => {
    const weekMap = new Map<string, number[]>()
    for (const r of healthHistoryRows) {
      if (r.overall_score == null) continue
      const d = new Date(r.calculated_at)
      const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())
      const key = weekStart.toISOString().slice(0, 10)
      if (!weekMap.has(key)) weekMap.set(key, [])
      weekMap.get(key)!.push(r.overall_score)
    }
    return Array.from(weekMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([date, scores]) => ({
        week: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      }))
  }, [healthHistoryRows])

  // ---- Compute insights from health data ----
  const healthInsights: InsightItem[] = useMemo(() => {
    if (!hasAnyData) return []
    const items: InsightItem[] = []

    const rawDimensions: { label: string; score: number | null }[] = [
      { label: 'Data Quality', score: breakdown.dataQuality },
      { label: 'Pipeline Health', score: breakdown.pipelineHealth },
      { label: 'Response Time', score: breakdown.responseTime },
      { label: 'Booking Rate', score: breakdown.bookingRate },
    ]
    const dimensions: { label: string; score: number }[] = rawDimensions.filter(
      (d): d is { label: string; score: number } => d.score != null
    )

    // Strongest area
    if (dimensions.length > 0) {
      const strongest = [...dimensions].sort((a, b) => b.score - a.score)[0]
      if (strongest.score > 60) {
        items.push({
          icon: 'trend_up',
          text: `Great job on ${strongest.label} — scoring ${strongest.score}/100, in the top tier`,
        })
      }

      // Weakest area
      const weakest = [...dimensions].sort((a, b) => a.score - b.score)[0]
      if (weakest.score < 70) {
        items.push({
          icon: 'trend_down',
          text: `Your weakest area is ${weakest.label} at ${weakest.score}/100 — focus improvement efforts here for the biggest impact`,
          priority: weakest.score < 40 ? 'high' : 'medium',
        })
      }
    }

    // Overall health context
    if (overallScore >= 70) {
      items.push({
        icon: 'tip',
        text: `Overall health score of ${overallScore} is strong — maintain consistency and watch for early warning dips`,
      })
    } else if (overallScore >= 40) {
      items.push({
        icon: 'warning',
        text: `Overall health score of ${overallScore} shows room for improvement — address the weakest dimension first`,
        priority: 'medium',
      })
    } else {
      items.push({
        icon: 'warning',
        text: `Overall health score of ${overallScore} needs urgent attention — multiple dimensions are underperforming`,
        priority: 'high',
      })
    }

    return items
  }, [hasAnyData, breakdown, overallScore])

  // Recommendations
  const recommendations: Recommendation[] = useMemo(() => {
    const recs: Recommendation[] = []
    if (dataQuality < 60) {
      recs.push({
        dimension: 'Data Quality',
        score: dataQuality,
        message: 'Improve data completeness by filling in missing booking values, event dates, and source information on existing records.',
        icon: Database,
      })
    }
    if (pipelineHealth < 60) {
      recs.push({
        dimension: 'Pipeline Health',
        score: pipelineHealth,
        message: 'Your pipeline has stale inquiries. Review and update the status of inquiries older than 30 days.',
        icon: TrendingUp,
      })
    }
    if (responseTime < 60) {
      recs.push({
        dimension: 'Response Time',
        score: responseTime,
        message: 'Average response times are above target. Consider enabling auto-replies for initial inquiry acknowledgment.',
        icon: Clock,
      })
    }
    if (bookingRate < 60) {
      recs.push({
        dimension: 'Booking Rate',
        score: bookingRate,
        message: 'Booking conversion is below benchmark. Audit your tour-to-booking process and consider follow-up sequence improvements.',
        icon: Target,
      })
    }
    if (recs.length === 0 && hasAnyData) {
      recs.push({
        dimension: 'Overall',
        score: overallScore,
        message: 'All health dimensions are performing well. Keep monitoring weekly for any changes.',
        icon: Activity,
      })
    }
    return recs
  }, [dataQuality, pipelineHealth, responseTime, bookingRate, overallScore, hasAnyData])

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Venue Health Score
        </h1>
        <p className="text-sage-600">
          A composite score measuring your venue's operational health — data quality, pipeline activity, response speed, and booking rate. Click any factor to see what's pulling your score up or down.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Activity className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {loading ? (
        <HealthSkeleton />
      ) : !hasAnyData ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Activity className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No data</h3>
          <p className="text-sm text-sage-600">Health scores will be calculated once venue activity is tracked.</p>
        </div>
      ) : (
        <>
          {/* Main health ring */}
          <div className="bg-surface border border-border rounded-xl p-8 shadow-sm flex flex-col items-center">
            {breakdown.overall != null ? (
              <LargeHealthRing score={overallScore} />
            ) : (
              <div className="text-center py-8">
                <p className="text-2xl font-bold text-sage-400">No data</p>
              </div>
            )}
            <p className="mt-4 text-sm text-sage-600">Overall Venue Health</p>
          </div>

          {/* Dimensional breakdown */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {breakdown.dataQuality != null && (
              <DimensionCard icon={Database} label="Data Quality" score={dataQuality} />
            )}
            {breakdown.pipelineHealth != null && (
              <DimensionCard icon={TrendingUp} label="Pipeline Health" score={pipelineHealth} />
            )}
            {breakdown.responseTime != null && (
              <DimensionCard icon={Clock} label="Response Time" score={responseTime} />
            )}
            {breakdown.bookingRate != null && (
              <DimensionCard icon={Target} label="Booking Rate" score={bookingRate} />
            )}
          </div>

          {/* AI Insights */}
          {healthInsights.length > 0 && (
            <InsightPanel insights={healthInsights} />
          )}

          {/* Historical chart */}
          {historyData.length > 1 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">
                Health Over Time (Last 12 Weeks)
              </h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historyData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                    <XAxis dataKey="week" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#FFF', border: '1px solid #E8E4DF', borderRadius: '8px', fontSize: '13px' }} />
                    <Line type="monotone" dataKey="score" stroke="#7D8471" strokeWidth={2} dot={{ r: 3, fill: '#7D8471' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Recommendations */}
          <div>
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4 flex items-center gap-2">
              <Lightbulb className="w-5 h-5 text-gold-500" />
              Recommendations
            </h2>
            <div className="space-y-3">
              {recommendations.map((rec) => {
                const RecIcon = rec.icon
                return (
                  <div key={rec.dimension} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${scoreBg(rec.score)}`}>
                        <RecIcon className={`w-4 h-4 ${scoreColor(rec.score)}`} />
                      </div>
                      <div>
                        <h3 className="font-medium text-sage-900 text-sm mb-1">
                          {rec.dimension} <span className={`font-bold ${scoreColor(rec.score)}`}>({rec.score})</span>
                        </h3>
                        <p className="text-sm text-sage-600 leading-relaxed">{rec.message}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
