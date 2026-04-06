'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useScope } from '@/lib/hooks/use-scope'
import { UpgradeGate } from '@/components/ui/upgrade-gate'
import {
  Building2,
  TrendingUp,
  DollarSign,
  CalendarCheck,
  Clock,
  Target,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
} from 'lucide-react'
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
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

interface VenueRow {
  id: string
  name: string
  state: string | null
}

interface WeddingRow {
  id: string
  venue_id: string
  status: string
  booking_value: number | null
  source: string | null
  created_at: string
}

interface VenueStats {
  venueId: string
  venueName: string
  inquiries: number
  tours: number
  bookings: number
  tourRate: number
  bookingRate: number
  avgRevenue: number
  healthScore: number
}

type SortKey = 'venueName' | 'inquiries' | 'tourRate' | 'bookingRate' | 'avgRevenue' | 'healthScore'
type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIE_COLORS = ['#7D8471', '#5D7A7A', '#A6894A', '#B8908A', '#6A7060', '#8FA88A', '#C4A96A']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function StatCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-24 bg-sage-100 rounded" />
        <div className="h-8 w-20 bg-sage-100 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function CompanyDashboardPageWrapper() {
  return (
    <UpgradeGate requiredTier="enterprise" featureName="Company Dashboard">
      <CompanyDashboardInner />
    </UpgradeGate>
  )
}

function CompanyDashboardInner() {
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('bookingRate')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const [venueRes, weddingRes] = await Promise.all([
        supabase.from('venues').select('id, name, state'),
        supabase.from('weddings').select('id, venue_id, status, booking_value, source, created_at'),
      ])
      if (venueRes.error) throw venueRes.error
      if (weddingRes.error) throw weddingRes.error
      setVenues((venueRes.data ?? []) as VenueRow[])
      setWeddings((weddingRes.data ?? []) as WeddingRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch company data:', err)
      setError('Failed to load company data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- YTD filter ----
  const ytdStart = new Date(new Date().getFullYear(), 0, 1).toISOString()
  const ytdWeddings = useMemo(
    () => weddings.filter((w) => w.created_at >= ytdStart),
    [weddings, ytdStart]
  )

  // ---- Aggregate stats ----
  const totalInquiries = ytdWeddings.length
  const totalBookings = ytdWeddings.filter((w) =>
    ['booked', 'contracted', 'completed'].includes(w.status)
  ).length
  const totalRevenue = ytdWeddings
    .filter((w) => ['booked', 'contracted', 'completed'].includes(w.status))
    .reduce((sum, w) => sum + (w.booking_value ?? 0), 0)
  const avgBookingRate =
    totalInquiries > 0 ? totalBookings / totalInquiries : 0

  // ---- Revenue by month (last 12 months) ----
  const revenueByMonth = useMemo(() => {
    const now = new Date()
    const months: { month: string; revenue: number }[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const label = `${MONTHS[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`
      const rev = weddings
        .filter((w) => {
          const wd = new Date(w.created_at)
          return (
            wd.getFullYear() === d.getFullYear() &&
            wd.getMonth() === d.getMonth() &&
            ['booked', 'contracted', 'completed'].includes(w.status)
          )
        })
        .reduce((s, w) => s + (w.booking_value ?? 0), 0)
      months.push({ month: label, revenue: rev })
    }
    return months
  }, [weddings])

  // ---- Source breakdown ----
  const sourceBreakdown = useMemo(() => {
    const map: Record<string, number> = {}
    for (const w of ytdWeddings) {
      const src = w.source || 'Unknown'
      map[src] = (map[src] || 0) + 1
    }
    return Object.entries(map)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
  }, [ytdWeddings])

  // ---- Per-venue stats ----
  const venueStats: VenueStats[] = useMemo(() => {
    return venues.map((v) => {
      const vw = ytdWeddings.filter((w) => w.venue_id === v.id)
      const inquiries = vw.length
      const tours = vw.filter((w) =>
        ['toured', 'held', 'contracted', 'completed'].includes(w.status)
      ).length
      const bookings = vw.filter((w) =>
        ['booked', 'contracted', 'completed'].includes(w.status)
      ).length
      const tourRate = inquiries > 0 ? tours / inquiries : 0
      const bookingRate = inquiries > 0 ? bookings / inquiries : 0
      const avgRevenue =
        bookings > 0
          ? vw
              .filter((w) => ['booked', 'contracted', 'completed'].includes(w.status))
              .reduce((s, w) => s + (w.booking_value ?? 0), 0) / bookings
          : 0
      // Simple health score: weighted sum of key rates
      const healthScore = Math.min(
        100,
        Math.round(bookingRate * 40 * 100 + tourRate * 30 * 100 + Math.min(inquiries / 50, 1) * 30)
      )
      return {
        venueId: v.id,
        venueName: v.name,
        inquiries,
        tours,
        bookings,
        tourRate,
        bookingRate,
        avgRevenue,
        healthScore,
      }
    })
  }, [venues, ytdWeddings])

  // ---- Sort handler ----
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedVenues = useMemo(() => {
    return [...venueStats].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sortDir === 'asc'
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number)
    })
  }, [venueStats, sortKey, sortDir])

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 text-sage-400" />
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3 h-3 text-sage-700" />
    ) : (
      <ChevronDown className="w-3 h-3 text-sage-700" />
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Company Overview
        </h1>
        <p className="text-sage-600">
          High-level business metrics across all your venues — total revenue, booking velocity, and conversion benchmarks. Use this as your executive snapshot.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Building2 className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatCard icon={TrendingUp} label="Inquiries YTD" value={String(totalInquiries)} color="teal" />
            <StatCard icon={DollarSign} label="Revenue YTD" value={fmt$(totalRevenue)} color="gold" />
            <StatCard icon={CalendarCheck} label="Bookings YTD" value={String(totalBookings)} color="sage" />
            <StatCard icon={Target} label="Avg Booking Rate" value={fmtPct(avgBookingRate)} color="emerald" />
            <StatCard icon={Clock} label="Avg Response Time" value="--" color="indigo" />
          </>
        )}
      </div>

      {/* Charts row */}
      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Revenue by month */}
          <div className="lg:col-span-2 bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">
              Revenue by Month (Last 12 Months)
            </h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={revenueByMonth} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#6A7060' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    formatter={(v) => { const n = Number(v) || 0; return [fmt$(n), 'Revenue']; }}
                    contentStyle={{ backgroundColor: '#FFF', border: '1px solid #E8E4DF', borderRadius: '8px', fontSize: '13px' }}
                  />
                  <Line type="monotone" dataKey="revenue" stroke="#7D8471" strokeWidth={2} dot={{ r: 3, fill: '#7D8471' }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Source breakdown pie */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">
              Top Inquiry Sources
            </h2>
            {sourceBreakdown.length === 0 ? (
              <p className="text-sm text-sage-500 text-center py-12">No source data</p>
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sourceBreakdown}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      dataKey="value"
                      nameKey="name"
                      paddingAngle={2}
                      label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
                    >
                      {sourceBreakdown.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Per-venue comparison table */}
      {!loading && sortedVenues.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Venue Comparison
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-warm-white">
                  {([
                    ['venueName', 'Venue'],
                    ['inquiries', 'Inquiries'],
                    ['tourRate', 'Tour Rate'],
                    ['bookingRate', 'Booking Rate'],
                    ['avgRevenue', 'Avg Revenue'],
                    ['healthScore', 'Health'],
                  ] as [SortKey, string][]).map(([key, label]) => (
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
                {sortedVenues.map((v) => (
                  <tr key={v.venueId} className="hover:bg-sage-50/50 transition-colors">
                    <td className="px-6 py-4 font-medium text-sage-900">{v.venueName}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{v.inquiries}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{fmtPct(v.tourRate)}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{fmtPct(v.bookingRate)}</td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">{fmt$(v.avgRevenue)}</td>
                    <td className="px-6 py-4">
                      <HealthBadge score={v.healthScore} />
                    </td>
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

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  color: string
}) {
  const bgMap: Record<string, string> = {
    teal: 'bg-teal-50',
    gold: 'bg-gold-50',
    sage: 'bg-sage-50',
    emerald: 'bg-emerald-50',
    indigo: 'bg-indigo-50',
  }
  const iconMap: Record<string, string> = {
    teal: 'text-teal-600',
    gold: 'text-gold-600',
    sage: 'text-sage-600',
    emerald: 'text-emerald-600',
    indigo: 'text-indigo-600',
  }
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${bgMap[color] ?? 'bg-sage-50'}`}>
          <Icon className={`w-4 h-4 ${iconMap[color] ?? 'text-sage-600'}`} />
        </div>
        <span className="text-sm font-medium text-sage-600">{label}</span>
      </div>
      <p className="text-2xl font-bold text-sage-900 tabular-nums">{value}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Health Badge
// ---------------------------------------------------------------------------

function HealthBadge({ score }: { score: number }) {
  const color =
    score > 70
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : score > 40
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${color}`}>
      {score}
    </span>
  )
}
