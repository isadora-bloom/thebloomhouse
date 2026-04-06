'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useRouter } from 'next/navigation'
import {
  Building2,
  TrendingUp,
  CalendarCheck,
  DollarSign,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  X,
} from 'lucide-react'

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

interface VenueRow {
  id: string
  name: string
  status: string
  state: string | null
}

interface WeddingRow {
  id: string
  venue_id: string
  status: string
  booking_value: number | null
  inquiry_date: string | null
  created_at: string
}

interface VenueHealthRow {
  venue_id: string
  overall_score: number
  data_quality_score: number | null
  pipeline_score: number | null
  response_time_score: number | null
  booking_rate_score: number | null
  calculated_at: string
}

interface InteractionRow {
  venue_id: string
  direction: string
  timestamp: string
}

interface VenueCardData {
  id: string
  name: string
  status: string
  healthScore: number
  healthBreakdown: {
    data_quality: number
    pipeline: number
    response_time: number
    booking_rate: number
  } | null
  healthHistory: { date: string; score: number }[]
  inquiriesThisMonth: number
  bookingsThisMonth: number
  revenueThisMonth: number
  totalRevenuePipeline: number
  avgResponseHours: number | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return `$${Math.round(v).toLocaleString()}`
}

function healthColor(score: number): string {
  if (score > 70) return 'text-emerald-500'
  if (score > 40) return 'text-amber-500'
  return 'text-red-500'
}

function healthBarBg(score: number): string {
  if (score > 70) return 'bg-emerald-500'
  if (score > 40) return 'bg-amber-500'
  return 'bg-red-500'
}

function statusBadge(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'onboarding':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'trial':
      return 'bg-purple-50 text-purple-700 border-purple-200'
    case 'paused':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'churned':
      return 'bg-red-50 text-red-700 border-red-200'
    default:
      return 'bg-sage-50 text-sage-700 border-sage-200'
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function VenueCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-36 bg-sage-100 rounded" />
          <div className="w-14 h-14 bg-sage-100 rounded-full" />
        </div>
        <div className="h-4 w-20 bg-sage-50 rounded" />
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 bg-sage-50 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Health Score Ring (clickable)
// ---------------------------------------------------------------------------

function HealthRing({
  score,
  size = 56,
  onClick,
}: {
  score: number
  size?: number
  onClick?: () => void
}) {
  const radius = (size - 8) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  const color = healthColor(score)

  return (
    <button
      onClick={onClick}
      className="relative group"
      style={{ width: size, height: size }}
      title="Click to see score breakdown"
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#E8E4DF"
          strokeWidth={4}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={`${color} transition-all`}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-sm font-bold ${color}`}>
        {Math.round(score)}
      </span>
      {onClick && (
        <span className="absolute -bottom-1 -right-1 w-4 h-4 bg-sage-200 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <ChevronDown className="w-3 h-3 text-sage-600" />
        </span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Health Score Breakdown Panel
// ---------------------------------------------------------------------------

function HealthBreakdownPanel({
  venue,
  onClose,
}: {
  venue: VenueCardData
  onClose: () => void
}) {
  const breakdown = venue.healthBreakdown
  const factors = breakdown
    ? [
        { label: 'Data Quality', score: breakdown.data_quality, desc: 'Completeness of venue profile, KB, and config' },
        { label: 'Pipeline Health', score: breakdown.pipeline, desc: 'Active leads, heat distribution, stage movement' },
        { label: 'Response Time', score: breakdown.response_time, desc: 'Speed of first reply to inquiries' },
        { label: 'Booking Rate', score: breakdown.booking_rate, desc: 'Inquiry-to-booking conversion rate' },
      ]
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <HealthRing score={venue.healthScore} size={48} />
            <div>
              <h3 className="font-heading text-base font-semibold text-sage-900">{venue.name}</h3>
              <p className="text-xs text-sage-500">Health Score Breakdown</p>
            </div>
          </div>
          <button onClick={onClose} className="text-sage-400 hover:text-sage-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Factor bars */}
        <div className="p-5 space-y-4">
          {factors.map((f) => (
            <div key={f.label}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-sage-800">{f.label}</span>
                <span className={`text-sm font-bold ${healthColor(f.score)}`}>{Math.round(f.score)}</span>
              </div>
              <div className="h-2 bg-sage-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${healthBarBg(f.score)}`}
                  style={{ width: `${f.score}%` }}
                />
              </div>
              <p className="text-[11px] text-sage-400 mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>

        {/* History sparkline */}
        {venue.healthHistory.length > 1 && (
          <div className="px-5 pb-5">
            <p className="text-xs font-medium text-sage-500 mb-2">Score over time</p>
            <div className="flex items-end gap-1 h-12">
              {venue.healthHistory.map((h, i) => {
                const max = Math.max(...venue.healthHistory.map((x) => x.score))
                const min = Math.min(...venue.healthHistory.map((x) => x.score))
                const range = max - min || 1
                const height = 12 + ((h.score - min) / range) * 36
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                    <div
                      className={`w-full rounded-sm ${healthBarBg(h.score)}`}
                      style={{ height: `${height}px` }}
                      title={`${new Date(h.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${Math.round(h.score)}`}
                    />
                  </div>
                )
              })}
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-sage-400">
                {new Date(venue.healthHistory[0].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <span className="text-[10px] text-sage-400">
                {new Date(venue.healthHistory[venue.healthHistory.length - 1].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function PortfolioOverviewPage() {
  const router = useRouter()
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [healthRows, setHealthRows] = useState<VenueHealthRow[]>([])
  const [interactions, setInteractions] = useState<InteractionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedVenueId, setExpandedVenueId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      // Fetch last 90 days of interactions for response time calc
      const ninetyDaysAgo = new Date()
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

      const [venueRes, weddingRes, healthRes, intRes] = await Promise.all([
        supabase.from('venues').select('id, name, status, state'),
        supabase
          .from('weddings')
          .select('id, venue_id, status, booking_value, inquiry_date, created_at'),
        supabase
          .from('venue_health')
          .select('venue_id, overall_score, data_quality_score, pipeline_score, response_time_score, booking_rate_score, calculated_at')
          .order('calculated_at', { ascending: true }),
        supabase
          .from('interactions')
          .select('venue_id, direction, timestamp')
          .gte('timestamp', ninetyDaysAgo.toISOString())
          .order('timestamp', { ascending: true }),
      ])
      if (venueRes.error) throw venueRes.error
      if (weddingRes.error) throw weddingRes.error
      if (healthRes.error) throw healthRes.error
      if (intRes.error) throw intRes.error

      setVenues((venueRes.data ?? []) as VenueRow[])
      setWeddings((weddingRes.data ?? []) as WeddingRow[])
      setHealthRows((healthRes.data ?? []) as VenueHealthRow[])
      setInteractions((intRes.data ?? []) as InteractionRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch portfolio data:', err)
      setError('Failed to load portfolio data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Compute card data
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const venueCards: VenueCardData[] = useMemo(() => {
    return venues.map((v) => {
      const vWeddings = weddings.filter((w) => w.venue_id === v.id)

      // This month: use inquiry_date OR created_at
      const thisMonth = vWeddings.filter(
        (w) => (w.inquiry_date ?? w.created_at) >= monthStart
      )

      // Bookings this month
      const bookingsThisMonth = thisMonth.filter((w) =>
        ['booked', 'contracted', 'completed'].includes(w.status)
      )

      // Revenue: all booked/contracted/completed weddings
      const allBooked = vWeddings.filter((w) =>
        ['booked', 'contracted', 'completed'].includes(w.status)
      )
      const totalRevenuePipeline = allBooked.reduce(
        (s, w) => s + (w.booking_value ?? 0),
        0
      )

      // Revenue this month
      const revenueThisMonth = bookingsThisMonth.reduce(
        (s, w) => s + (w.booking_value ?? 0),
        0
      )

      // Health: latest row
      const venueHealth = healthRows.filter((h) => h.venue_id === v.id)
      const latest = venueHealth[venueHealth.length - 1]

      // Health history for chart
      const healthHistory = venueHealth.map((h) => ({
        date: h.calculated_at,
        score: h.overall_score,
      }))

      // Avg response time (rough: time between first inbound and first outbound per thread)
      const venueInts = interactions.filter((i) => i.venue_id === v.id)
      const inbound = venueInts.filter((i) => i.direction === 'inbound')
      const outbound = venueInts.filter((i) => i.direction === 'outbound')
      let avgResponseHours: number | null = null
      if (inbound.length > 0 && outbound.length > 0) {
        // Simple: avg time gap between consecutive inbound→outbound pairs
        const gaps: number[] = []
        for (const ib of inbound) {
          const reply = outbound.find(
            (ob) => new Date(ob.timestamp) > new Date(ib.timestamp)
          )
          if (reply) {
            const gap =
              (new Date(reply.timestamp).getTime() -
                new Date(ib.timestamp).getTime()) /
              (1000 * 60 * 60)
            if (gap < 72) gaps.push(gap) // exclude stale
          }
        }
        if (gaps.length > 0) {
          avgResponseHours =
            Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) /
            10
        }
      }

      return {
        id: v.id,
        name: v.name,
        status: v.status,
        healthScore: latest?.overall_score ?? 0,
        healthBreakdown: latest
          ? {
              data_quality: latest.data_quality_score ?? 0,
              pipeline: latest.pipeline_score ?? 0,
              response_time: latest.response_time_score ?? 0,
              booking_rate: latest.booking_rate_score ?? 0,
            }
          : null,
        healthHistory,
        inquiriesThisMonth: thisMonth.filter((w) => w.status === 'inquiry').length,
        bookingsThisMonth: bookingsThisMonth.length,
        revenueThisMonth,
        totalRevenuePipeline,
        avgResponseHours,
      }
    })
  }, [venues, weddings, healthRows, interactions, monthStart])

  // Company-level stats
  const totalInquiries = venueCards.reduce((s, v) => s + v.inquiriesThisMonth, 0)
  const totalBookings = venueCards.reduce((s, v) => s + v.bookingsThisMonth, 0)
  const totalPipelineRevenue = venueCards.reduce((s, v) => s + v.totalRevenuePipeline, 0)
  const avgHealth =
    venueCards.length > 0
      ? Math.round(venueCards.reduce((s, v) => s + v.healthScore, 0) / venueCards.length)
      : 0

  const expandedVenue = venueCards.find((v) => v.id === expandedVenueId) ?? null

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Portfolio Overview
        </h1>
        <p className="text-sage-600">
          All venues at a glance — health scores, inquiry volume, bookings, and response times side by side. Click any venue card to drill into that venue's dashboard, or click a health score for the breakdown.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              fetchData()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Company-level summary */}
      {!loading && venueCards.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-teal-500" />
              <span className="text-xs text-sage-500">Inquiries (month)</span>
            </div>
            <p className="text-2xl font-bold text-sage-900">{totalInquiries}</p>
          </div>
          <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <CalendarCheck className="w-4 h-4 text-gold-500" />
              <span className="text-xs text-sage-500">Bookings (month)</span>
            </div>
            <p className="text-2xl font-bold text-sage-900">{totalBookings}</p>
          </div>
          <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-sage-500" />
              <span className="text-xs text-sage-500">Pipeline Revenue</span>
            </div>
            <p className="text-2xl font-bold text-sage-900">
              {fmt$(totalPipelineRevenue)}
            </p>
          </div>
          <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-sage-400" />
              <span className="text-xs text-sage-500">Avg Health</span>
            </div>
            <p className={`text-2xl font-bold ${healthColor(avgHealth)}`}>
              {avgHealth}
            </p>
          </div>
        </div>
      )}

      {/* Venue Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <VenueCardSkeleton key={i} />
          ))}
        </div>
      ) : venueCards.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Building2 className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No venues found
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Venues will appear here once onboarded.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {venueCards.map((vc) => (
            <div
              key={vc.id}
              className={`bg-surface border rounded-xl shadow-sm hover:shadow-md transition-all ${
                vc.healthScore > 70
                  ? 'border-emerald-200 hover:border-emerald-300'
                  : vc.healthScore > 40
                    ? 'border-amber-200 hover:border-amber-300'
                    : 'border-red-200 hover:border-red-300'
              }`}
            >
              {/* Clickable card body */}
              <button
                onClick={() => {
                  document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify({ level: 'venue', venueId: vc.id, venueName: vc.name, companyName: 'The Crestwood Collection' }))}; path=/; max-age=${60 * 60 * 24 * 365}`
                  document.cookie = `bloom_venue=${vc.id}; path=/; max-age=${60 * 60 * 24 * 365}`
                  router.push('/intel/dashboard')
                  window.location.reload()
                }}
                className="w-full text-left p-6 pb-4"
              >
                {/* Top row */}
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="font-heading text-base font-semibold text-sage-900 mb-1">
                      {vc.name}
                    </h3>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${statusBadge(vc.status)}`}
                    >
                      {vc.status}
                    </span>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <HealthRing
                      score={vc.healthScore}
                      onClick={() => setExpandedVenueId(vc.id)}
                    />
                  </div>
                </div>

                {/* Metrics row */}
                <div className="grid grid-cols-4 gap-2">
                  <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
                    <div className="flex items-center gap-1 mb-0.5">
                      <TrendingUp className="w-3 h-3 text-teal-500" />
                      <span className="text-[10px] text-sage-500">Inquiries</span>
                    </div>
                    <p className="text-base font-bold text-sage-900 tabular-nums">
                      {vc.inquiriesThisMonth}
                    </p>
                  </div>
                  <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
                    <div className="flex items-center gap-1 mb-0.5">
                      <CalendarCheck className="w-3 h-3 text-gold-500" />
                      <span className="text-[10px] text-sage-500">Booked</span>
                    </div>
                    <p className="text-base font-bold text-sage-900 tabular-nums">
                      {vc.bookingsThisMonth}
                    </p>
                  </div>
                  <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
                    <div className="flex items-center gap-1 mb-0.5">
                      <DollarSign className="w-3 h-3 text-sage-500" />
                      <span className="text-[10px] text-sage-500">Revenue</span>
                    </div>
                    <p className="text-base font-bold text-sage-900 tabular-nums">
                      {fmt$(vc.totalRevenuePipeline)}
                    </p>
                  </div>
                  <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
                    <div className="flex items-center gap-1 mb-0.5">
                      <Clock className="w-3 h-3 text-teal-500" />
                      <span className="text-[10px] text-sage-500">Resp.</span>
                    </div>
                    <p className={`text-base font-bold tabular-nums ${
                      vc.avgResponseHours === null
                        ? 'text-sage-300'
                        : vc.avgResponseHours <= 2
                          ? 'text-emerald-600'
                          : vc.avgResponseHours <= 6
                            ? 'text-amber-600'
                            : 'text-red-600'
                    }`}>
                      {vc.avgResponseHours !== null
                        ? `${vc.avgResponseHours}h`
                        : '—'}
                    </p>
                  </div>
                </div>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Health breakdown modal */}
      {expandedVenue && (
        <HealthBreakdownPanel
          venue={expandedVenue}
          onClose={() => setExpandedVenueId(null)}
        />
      )}
    </div>
  )
}
