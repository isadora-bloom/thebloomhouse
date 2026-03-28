'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Users,
  Trophy,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  Clock,
  Target,
  DollarSign,
  Mail,
  CalendarCheck,
  TrendingUp,
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

interface ConsultantMetric {
  id: string
  venue_id: string
  user_id: string
  period_start: string
  period_end: string
  inquiries_handled: number
  tours_booked: number
  bookings_closed: number
  conversion_rate: number
  avg_response_time_minutes: number
  avg_booking_value: number
}

interface UserProfile {
  id: string
  full_name: string
  role: string
}

interface VenueRow {
  id: string
  name: string
}

interface TeamRow {
  name: string
  venue: string
  inquiries: number
  tours: number
  bookings: number
  conversionRate: number
  avgResponseTime: number
  avgBookingValue: number
}

type Period = 'this_month' | 'last_month' | 'quarter'
type SortKey = keyof Omit<TeamRow, 'name' | 'venue'>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPeriodDates(period: Period): { start: string; end: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  switch (period) {
    case 'this_month':
      return {
        start: new Date(y, m, 1).toISOString().slice(0, 10),
        end: new Date(y, m + 1, 0).toISOString().slice(0, 10),
      }
    case 'last_month':
      return {
        start: new Date(y, m - 1, 1).toISOString().slice(0, 10),
        end: new Date(y, m, 0).toISOString().slice(0, 10),
      }
    case 'quarter':
      return {
        start: new Date(y, m - 3, 1).toISOString().slice(0, 10),
        end: new Date(y, m + 1, 0).toISOString().slice(0, 10),
      }
  }
}

function fmtMin(v: number): string {
  if (v < 60) return `${Math.round(v)}m`
  const h = Math.floor(v / 60)
  const mins = Math.round(v % 60)
  return mins > 0 ? `${h}h ${mins}m` : `${h}h`
}

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-6 space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="animate-pulse flex gap-4">
            <div className="h-5 w-32 bg-sage-100 rounded" />
            <div className="h-5 w-24 bg-sage-50 rounded" />
            <div className="h-5 w-16 bg-sage-50 rounded" />
            <div className="h-5 w-16 bg-sage-50 rounded" />
            <div className="h-5 w-16 bg-sage-50 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function TeamComparePage() {
  const [rows, setRows] = useState<TeamRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('this_month')
  const [sortKey, setSortKey] = useState<SortKey>('bookings')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    const { start, end } = getPeriodDates(period)
    try {
      const [metricRes, profileRes, venueRes] = await Promise.all([
        supabase
          .from('consultant_metrics')
          .select('*')
          .gte('period_start', start)
          .lte('period_end', end),
        supabase.from('user_profiles').select('id, full_name, role'),
        supabase.from('venues').select('id, name'),
      ])
      if (metricRes.error) throw metricRes.error
      if (profileRes.error) throw profileRes.error
      if (venueRes.error) throw venueRes.error

      const metrics = (metricRes.data ?? []) as ConsultantMetric[]
      const profiles = (profileRes.data ?? []) as UserProfile[]
      const venues = (venueRes.data ?? []) as VenueRow[]

      const profileMap = new Map(profiles.map((p) => [p.id, p]))
      const venueMap = new Map(venues.map((v) => [v.id, v.name]))

      // Aggregate by user + venue
      const agg = new Map<string, TeamRow>()
      for (const m of metrics) {
        const key = `${m.user_id}-${m.venue_id}`
        const existing = agg.get(key)
        if (!existing) {
          agg.set(key, {
            name: profileMap.get(m.user_id)?.full_name ?? 'Unknown',
            venue: venueMap.get(m.venue_id) ?? 'Unknown',
            inquiries: m.inquiries_handled,
            tours: m.tours_booked,
            bookings: m.bookings_closed,
            conversionRate: m.conversion_rate,
            avgResponseTime: m.avg_response_time_minutes,
            avgBookingValue: m.avg_booking_value,
          })
        } else {
          existing.inquiries += m.inquiries_handled
          existing.tours += m.tours_booked
          existing.bookings += m.bookings_closed
          existing.avgResponseTime = (existing.avgResponseTime + m.avg_response_time_minutes) / 2
          existing.avgBookingValue = (existing.avgBookingValue + m.avg_booking_value) / 2
          existing.conversionRate =
            existing.inquiries > 0 ? existing.bookings / existing.inquiries : 0
        }
      }

      setRows(Array.from(agg.values()))
      setError(null)
    } catch (err) {
      console.error('Failed to fetch team comparison data:', err)
      setError('Failed to load team comparison data')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    setLoading(true)
    fetchData()
  }, [fetchData])

  // Sort
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        sortDir === 'asc'
          ? (a[sortKey] as number) - (b[sortKey] as number)
          : (b[sortKey] as number) - (a[sortKey] as number)
      ),
    [rows, sortKey, sortDir]
  )

  // Leaderboard (top 3 by bookings)
  const leaders = useMemo(
    () => [...rows].sort((a, b) => b.bookings - a.bookings).slice(0, 3),
    [rows]
  )

  const periods: { key: Period; label: string }[] = [
    { key: 'this_month', label: 'This Month' },
    { key: 'last_month', label: 'Last Month' },
    { key: 'quarter', label: 'Quarter' },
  ]

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 text-sage-400" />
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3 h-3 text-sage-700" />
    ) : (
      <ChevronDown className="w-3 h-3 text-sage-700" />
    )
  }

  const medalColors = ['text-gold-500', 'text-sage-400', 'text-amber-600']

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Team Comparison
          </h1>
          <p className="text-sage-600">
            Coordinator performance across all venues.
          </p>
        </div>
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

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Users className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Leaderboard */}
      {!loading && leaders.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {leaders.map((l, i) => (
            <div key={`${l.name}-${l.venue}`} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <Trophy className={`w-5 h-5 ${medalColors[i]}`} />
                <div>
                  <p className="font-heading text-sm font-semibold text-sage-900">{l.name}</p>
                  <p className="text-xs text-sage-500">{l.venue}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-sm text-sage-700">
                <span className="flex items-center gap-1">
                  <CalendarCheck className="w-3 h-3" /> {l.bookings} bookings
                </span>
                <span className="flex items-center gap-1">
                  <Target className="w-3 h-3" /> {fmtPct(l.conversionRate)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <TableSkeleton />
      ) : sorted.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Users className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No team data for this period
          </h3>
          <p className="text-sm text-sage-600">Consultant metrics will appear once activity is tracked.</p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-warm-white">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Name</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Venue</th>
                  {([
                    ['inquiries', 'Inquiries', Mail],
                    ['tours', 'Tours', CalendarCheck],
                    ['bookings', 'Bookings', Target],
                    ['conversionRate', 'Conv. Rate', TrendingUp],
                    ['avgResponseTime', 'Avg Response', Clock],
                    ['avgBookingValue', 'Avg Value', DollarSign],
                  ] as [SortKey, string, React.ComponentType<{ className?: string }>][]).map(([key, label]) => (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600 cursor-pointer select-none hover:text-sage-900 transition-colors"
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        <SortIcon col={key} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((r, i) => (
                  <tr key={`${r.name}-${r.venue}-${i}`} className="hover:bg-sage-50/50 transition-colors">
                    <td className="px-6 py-4 font-medium text-sage-900">{r.name}</td>
                    <td className="px-6 py-4 text-sage-600">{r.venue}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{r.inquiries}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{r.tours}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{r.bookings}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{fmtPct(r.conversionRate)}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{fmtMin(r.avgResponseTime)}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{fmt$(r.avgBookingValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
