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

interface VenueHealthRow {
  id: string
  venue_id: string
  overall_score: number
  data_quality_score: number
  pipeline_health_score: number
  response_time_score: number
  booking_rate_score: number
  created_at: string
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
  const [healthRecords, setHealthRecords] = useState<VenueHealthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const { data, error: err } = await supabase
        .from('venue_health')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      if (err) throw err
      setHealthRecords((data ?? []) as VenueHealthRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch health data:', err)
      setError('Failed to load health data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Latest record
  const latest = healthRecords[0] ?? null
  const overallScore = latest?.overall_score ?? 0
  const dataQuality = latest?.data_quality_score ?? 0
  const pipelineHealth = latest?.pipeline_health_score ?? 0
  const responseTime = latest?.response_time_score ?? 0
  const bookingRate = latest?.booking_rate_score ?? 0

  // Historical (last 12 weeks)
  const historyData = useMemo(() => {
    // Group by week (take latest per week)
    const weekMap = new Map<string, number>()
    for (const r of healthRecords) {
      const d = new Date(r.created_at)
      const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())
      const key = weekStart.toISOString().slice(0, 10)
      if (!weekMap.has(key)) {
        weekMap.set(key, r.overall_score)
      }
    }
    return Array.from(weekMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([date, score]) => ({
        week: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        score,
      }))
  }, [healthRecords])

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
    if (recs.length === 0 && latest) {
      recs.push({
        dimension: 'Overall',
        score: overallScore,
        message: 'All health dimensions are performing well. Keep monitoring weekly for any changes.',
        icon: Activity,
      })
    }
    return recs
  }, [dataQuality, pipelineHealth, responseTime, bookingRate, overallScore, latest])

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Venue Health Score
        </h1>
        <p className="text-sage-600">
          Multi-dimensional venue health assessment and improvement recommendations.
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
      ) : !latest ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Activity className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No health data</h3>
          <p className="text-sm text-sage-600">Health scores will be calculated once venue activity is tracked.</p>
        </div>
      ) : (
        <>
          {/* Main health ring */}
          <div className="bg-surface border border-border rounded-xl p-8 shadow-sm flex flex-col items-center">
            <LargeHealthRing score={overallScore} />
            <p className="mt-4 text-sm text-sage-600">Overall Venue Health</p>
          </div>

          {/* Dimensional breakdown */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <DimensionCard icon={Database} label="Data Quality" score={dataQuality} />
            <DimensionCard icon={TrendingUp} label="Pipeline Health" score={pipelineHealth} />
            <DimensionCard icon={Clock} label="Response Time" score={responseTime} />
            <DimensionCard icon={Target} label="Booking Rate" score={bookingRate} />
          </div>

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
