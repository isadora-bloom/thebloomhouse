'use client'

import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Users,
  Clock,
  Target,
  DollarSign,
  Mail,
  CalendarCheck,
  TrendingUp,
  User,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'

// TODO: Replace with venue context from auth/session
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConsultantMetric {
  id: string
  venue_id: string
  consultant_id: string
  period_start: string
  period_end: string
  inquiries_handled: number
  tours_booked: number
  bookings_closed: number
  conversion_rate: number
  avg_response_time_minutes: number
  avg_booking_value: number
  calculated_at: string
}

interface UserProfile {
  id: string
  first_name: string | null
  last_name: string | null
  role: string
  avatar_url: string | null
}

function getFullName(profile: UserProfile): string {
  return [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Unknown'
}

interface ConsultantData {
  profile: UserProfile
  metrics: ConsultantMetric
}

type Period = 'this_month' | 'last_month' | 'last_3_months'

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPeriodDates(period: Period): { start: string; end: string } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()

  switch (period) {
    case 'this_month': {
      const start = new Date(year, month, 1)
      const end = new Date(year, month + 1, 0)
      return {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      }
    }
    case 'last_month': {
      const start = new Date(year, month - 1, 1)
      const end = new Date(year, month, 0)
      return {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      }
    }
    case 'last_3_months': {
      const start = new Date(year, month - 3, 1)
      const end = new Date(year, month + 1, 0)
      return {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      }
    }
  }
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const mins = Math.round(minutes % 60)
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function fmt$(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

const AVATAR_COLORS = [
  'bg-teal-100 text-teal-700',
  'bg-gold-100 text-gold-700',
  'bg-sage-200 text-sage-700',
  'bg-rose-100 text-rose-700',
  'bg-indigo-100 text-indigo-700',
  'bg-amber-100 text-amber-700',
]

const CHART_COLORS = {
  inquiries: '#7D8471',
  tours: '#5D7A7A',
  bookings: '#A6894A',
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ConsultantCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-sage-100 rounded-full" />
          <div className="space-y-2">
            <div className="h-5 w-32 bg-sage-100 rounded" />
            <div className="h-3 w-20 bg-sage-50 rounded" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-14 bg-sage-50 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Consultant Card
// ---------------------------------------------------------------------------

function ConsultantCard({
  data,
  colorIndex,
}: {
  data: ConsultantData
  colorIndex: number
}) {
  const { profile, metrics } = data
  const avatarColor = AVATAR_COLORS[colorIndex % AVATAR_COLORS.length]

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow">
      {/* Header: avatar + name */}
      <div className="flex items-center gap-3 mb-5">
        {profile.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt={getFullName(profile)}
            className="w-12 h-12 rounded-full object-cover border-2 border-sage-100"
          />
        ) : (
          <div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold ${avatarColor}`}>
            {getInitials(getFullName(profile))}
          </div>
        )}
        <div>
          <h3 className="font-heading text-base font-semibold text-sage-900">
            {getFullName(profile)}
          </h3>
          <span className="text-xs font-medium text-sage-500 capitalize">
            {profile.role.replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3">
        <MetricTile
          icon={Mail}
          label="Inquiries"
          value={String(metrics.inquiries_handled)}
          iconColor="text-sage-500"
          iconBg="bg-sage-50"
        />
        <MetricTile
          icon={CalendarCheck}
          label="Tours Booked"
          value={String(metrics.tours_booked)}
          iconColor="text-teal-500"
          iconBg="bg-teal-50"
        />
        <MetricTile
          icon={Target}
          label="Bookings"
          value={String(metrics.bookings_closed)}
          iconColor="text-gold-500"
          iconBg="bg-gold-50"
        />
        <MetricTile
          icon={TrendingUp}
          label="Conversion"
          value={fmtPct(metrics.conversion_rate)}
          iconColor="text-emerald-500"
          iconBg="bg-emerald-50"
        />
        <MetricTile
          icon={Clock}
          label="Avg Response"
          value={fmtMinutes(metrics.avg_response_time_minutes)}
          iconColor="text-indigo-500"
          iconBg="bg-indigo-50"
        />
        <MetricTile
          icon={DollarSign}
          label="Avg Booking"
          value={fmt$(metrics.avg_booking_value)}
          iconColor="text-rose-500"
          iconBg="bg-rose-50"
        />
      </div>
    </div>
  )
}

function MetricTile({
  icon: Icon,
  label,
  value,
  iconColor,
  iconBg,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  iconColor: string
  iconBg: string
}) {
  return (
    <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
      <div className="flex items-center gap-2 mb-1">
        <div className={`p-1 rounded ${iconBg}`}>
          <Icon className={`w-3 h-3 ${iconColor}`} />
        </div>
        <span className="text-xs text-sage-500">{label}</span>
      </div>
      <p className="text-lg font-bold text-sage-900 tabular-nums">{value}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function TeamPerformancePage() {
  const [consultants, setConsultants] = useState<ConsultantData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('this_month')

  // ---- Fetch data ----
  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    const { start, end } = getPeriodDates(period)

    try {
      // Fetch metrics for the period
      const { data: metricsData, error: metricsErr } = await supabase
        .from('consultant_metrics')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .gte('period_start', start)
        .lte('period_end', end)
        .order('bookings_closed', { ascending: false })

      if (metricsErr) throw metricsErr

      const metrics = (metricsData ?? []) as ConsultantMetric[]

      if (metrics.length === 0) {
        setConsultants([])
        setError(null)
        setLoading(false)
        return
      }

      // Get unique user IDs and fetch profiles
      const userIds = Array.from(new Set(metrics.map((m) => m.consultant_id)))

      const { data: profilesData, error: profilesErr } = await supabase
        .from('user_profiles')
        .select('id, first_name, last_name, role, avatar_url')
        .in('id', userIds)

      if (profilesErr) throw profilesErr

      const profileMap = new Map<string, UserProfile>()
      for (const p of (profilesData ?? []) as UserProfile[]) {
        profileMap.set(p.id, p)
      }

      // Aggregate metrics per consultant (in case of multiple periods)
      const consultantMap = new Map<string, ConsultantMetric>()

      for (const m of metrics) {
        const existing = consultantMap.get(m.consultant_id)
        if (!existing) {
          consultantMap.set(m.consultant_id, { ...m })
        } else {
          existing.inquiries_handled += m.inquiries_handled
          existing.tours_booked += m.tours_booked
          existing.bookings_closed += m.bookings_closed
          existing.avg_response_time_minutes =
            (existing.avg_response_time_minutes + m.avg_response_time_minutes) / 2
          existing.avg_booking_value =
            (existing.avg_booking_value + m.avg_booking_value) / 2
          // Recalculate conversion rate
          existing.conversion_rate =
            existing.inquiries_handled > 0
              ? existing.bookings_closed / existing.inquiries_handled
              : 0
        }
      }

      const result: ConsultantData[] = []
      for (const [userId, aggMetrics] of consultantMap) {
        const profile = profileMap.get(userId)
        if (profile) {
          result.push({ profile, metrics: aggMetrics })
        }
      }

      // Sort by bookings closed descending
      result.sort((a, b) => b.metrics.bookings_closed - a.metrics.bookings_closed)

      setConsultants(result)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch team performance data:', err)
      setError('Failed to load team performance data')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    setLoading(true)
    fetchData()
  }, [fetchData])

  // ---- Chart data ----
  const chartData = consultants.map((c) => ({
    name: c.profile.first_name || getFullName(c.profile).split(' ')[0],
    inquiries: c.metrics.inquiries_handled,
    tours: c.metrics.tours_booked,
    bookings: c.metrics.bookings_closed,
  }))

  const periods: { key: Period; label: string }[] = [
    { key: 'this_month', label: 'This Month' },
    { key: 'last_month', label: 'Last Month' },
    { key: 'last_3_months', label: 'Last 3 Months' },
  ]

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Team Performance
          </h1>
          <p className="text-sage-600">
            Consultant metrics, comparisons, and conversion tracking.
          </p>
        </div>

        {/* Period selector */}
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {periods.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                period === p.key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Users className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Consultant Cards ---- */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <ConsultantCardSkeleton key={i} />
          ))}
        </div>
      ) : consultants.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <User className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No consultant data for this period
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Consultant performance metrics will appear here once inquiry and booking activity is tracked.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {consultants.map((c, i) => (
            <ConsultantCard key={c.profile.id} data={c} colorIndex={i} />
          ))}
        </div>
      )}

      {/* ---- Comparison Chart ---- */}
      {!loading && chartData.length > 1 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-4 flex items-center gap-2">
            <BarChart className="w-5 h-5 text-sage-600" />
            Consultant Comparison
          </h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    border: '1px solid #E8E4DF',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                <Bar
                  dataKey="inquiries"
                  name="Inquiries"
                  fill={CHART_COLORS.inquiries}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="tours"
                  name="Tours"
                  fill={CHART_COLORS.tours}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="bookings"
                  name="Bookings"
                  fill={CHART_COLORS.bookings}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}
