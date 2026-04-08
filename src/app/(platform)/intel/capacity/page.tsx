'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  CalendarRange,
  TrendingUp,
  DollarSign,
  BarChart3,
  ArrowUp,
  ArrowDown,
  Minus,
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

interface WeddingRow {
  id: string
  venue_id: string
  status: string
  booking_value: number | null
  wedding_date: string | null
  created_at: string
}

interface MonthData {
  month: string
  label: string
  booked: number
  held: number
  available: number
  occupancy: number
  avgRevenue: number
  priceAdjust: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Assume max events per month (configurable per venue later)
const MAX_EVENTS_PER_MONTH = 8

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

function occupancyColor(pct: number): string {
  if (pct >= 80) return 'bg-emerald-500'
  if (pct >= 50) return 'bg-amber-500'
  if (pct > 0) return 'bg-sage-400'
  return 'bg-sage-200'
}

function occupancyTextColor(pct: number): string {
  if (pct >= 80) return 'text-emerald-700'
  if (pct >= 50) return 'text-amber-700'
  return 'text-sage-600'
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function MonthCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-12 bg-sage-100 rounded" />
        <div className="h-3 w-full bg-sage-50 rounded" />
        <div className="h-8 w-16 bg-sage-100 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function CapacityPage() {
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [year, setYear] = useState(new Date().getFullYear())

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const { data, error: err } = await supabase
        .from('weddings')
        .select('id, venue_id, status, booking_value, wedding_date, created_at')
      if (err) throw err
      setWeddings((data ?? []) as WeddingRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch capacity data:', err)
      setError('Failed to load capacity data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Monthly grid
  const monthData: MonthData[] = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const monthStr = `${year}-${String(i + 1).padStart(2, '0')}`
      const monthWeddings = weddings.filter((w) => {
        const d = w.wedding_date ?? w.created_at
        return d.startsWith(monthStr)
      })

      const booked = monthWeddings.filter((w) =>
        ['contracted', 'completed'].includes(w.status)
      ).length
      const held = monthWeddings.filter((w) => w.status === 'held').length
      const available = Math.max(0, MAX_EVENTS_PER_MONTH - booked - held)
      const occupancy = Math.round(((booked + held) / MAX_EVENTS_PER_MONTH) * 100)

      const bookedWeddings = monthWeddings.filter((w) =>
        ['contracted', 'completed'].includes(w.status)
      )
      const avgRevenue =
        bookedWeddings.length > 0
          ? bookedWeddings.reduce((s, w) => s + (w.booking_value ?? 0), 0) / bookedWeddings.length
          : 0

      // Suggested price adjustment: high occupancy = raise, low = lower
      let priceAdjust = 0
      if (occupancy >= 90) priceAdjust = 15
      else if (occupancy >= 75) priceAdjust = 10
      else if (occupancy >= 60) priceAdjust = 5
      else if (occupancy < 25) priceAdjust = -15
      else if (occupancy < 40) priceAdjust = -10

      return {
        month: monthStr,
        label: MONTHS[i],
        booked,
        held,
        available,
        occupancy,
        avgRevenue,
        priceAdjust,
      }
    })
  }, [weddings, year])

  // Summary
  const overallOccupancy = useMemo(() => {
    const total = monthData.reduce((s, m) => s + m.booked + m.held, 0)
    const max = MAX_EVENTS_PER_MONTH * 12
    return max > 0 ? Math.round((total / max) * 100) : 0
  }, [monthData])

  const totalBookings = monthData.reduce((s, m) => s + m.booked, 0)
  const totalRevenue = weddings
    .filter((w) => {
      const d = w.wedding_date ?? w.created_at
      return d.startsWith(String(year)) && ['contracted', 'completed'].includes(w.status)
    })
    .reduce((s, w) => s + (w.booking_value ?? 0), 0)
  const peakMonth = [...monthData].sort((a, b) => b.occupancy - a.occupancy)[0]

  const years = [year - 1, year, year + 1]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Capacity & Yield
          </h1>
          <p className="text-sage-600">
            Understand how full your calendar is and where you have availability gaps. Use this to optimize pricing for off-peak dates and maximize revenue per available date.
          </p>
        </div>
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {years.map((y) => (
            <button
              key={y}
              onClick={() => setYear(y)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                year === y
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <CalendarRange className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <MonthCardSkeleton key={i} />)
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="w-4 h-4 text-teal-500" />
                <span className="text-sm font-medium text-sage-600">Overall Occupancy</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{overallOccupancy}%</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <CalendarRange className="w-4 h-4 text-gold-500" />
                <span className="text-sm font-medium text-sage-600">Total Bookings</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{totalBookings}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-sage-500" />
                <span className="text-sm font-medium text-sage-600">Revenue Booked</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{fmt$(totalRevenue)}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-medium text-sage-600">Peak Month</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">
                {peakMonth ? `${peakMonth.label} (${peakMonth.occupancy}%)` : '--'}
              </p>
            </div>
          </>
        )}
      </div>

      {/* Monthly grid */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <MonthCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
          {monthData.map((m) => (
            <div key={m.month} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <h3 className="font-heading text-sm font-semibold text-sage-900 mb-3">{m.label}</h3>

              {/* Occupancy bar */}
              <div className="mb-3">
                <div className="flex items-center justify-between text-xs text-sage-500 mb-1">
                  <span>Occupancy</span>
                  <span className={`font-semibold ${occupancyTextColor(m.occupancy)}`}>{m.occupancy}%</span>
                </div>
                <div className="h-2 bg-sage-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${occupancyColor(m.occupancy)}`}
                    style={{ width: `${Math.min(m.occupancy, 100)}%` }}
                  />
                </div>
              </div>

              {/* Counts */}
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-sage-500">Booked</span>
                  <span className="font-medium text-sage-800 tabular-nums">{m.booked}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sage-500">Held</span>
                  <span className="font-medium text-amber-600 tabular-nums">{m.held}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sage-500">Available</span>
                  <span className="font-medium text-sage-600 tabular-nums">{m.available}</span>
                </div>
              </div>

              {/* Revenue */}
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-xs text-sage-500">Avg Revenue</p>
                <p className="text-sm font-bold text-sage-900 tabular-nums">{fmt$(m.avgRevenue)}</p>
              </div>

              {/* Price suggestion */}
              {m.priceAdjust !== 0 && (
                <div className={`mt-2 flex items-center gap-1 text-xs font-medium ${
                  m.priceAdjust > 0 ? 'text-emerald-600' : 'text-red-600'
                }`}>
                  {m.priceAdjust > 0 ? (
                    <ArrowUp className="w-3 h-3" />
                  ) : (
                    <ArrowDown className="w-3 h-3" />
                  )}
                  Suggest {m.priceAdjust > 0 ? '+' : ''}{m.priceAdjust}%
                </div>
              )}
              {m.priceAdjust === 0 && (
                <div className="mt-2 flex items-center gap-1 text-xs text-sage-400">
                  <Minus className="w-3 h-3" /> On target
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
