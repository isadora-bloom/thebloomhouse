'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  CalendarRange,
  TrendingUp,
  DollarSign,
  BarChart3,
  Building2,
  AlertCircle,
} from 'lucide-react'
import { useScope, scopeVenueFilter } from '@/lib/hooks/use-scope'

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

interface CapacityStats {
  year: number
  available_saturdays: number
  booked_count: number
  utilisation_pct: number
  total_revenue: number
  yield_per_available: number
  yield_per_booked: number
  avg_booking_value: number
}

interface VenueRow {
  id: string
  name: string
  status: string
}

interface VenueConfigRow {
  venue_id: string
  feature_flags: Record<string, unknown> | null
}

interface VenueCapacity {
  id: string
  name: string
  status: string
  stats: CapacityStats | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return `$${Math.round(v).toLocaleString()}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return `${v.toFixed(1)}%`
}

function utilisationColor(pct: number): string {
  if (pct >= 60) return 'bg-emerald-500'
  if (pct >= 30) return 'bg-amber-500'
  if (pct > 0) return 'bg-sage-400'
  return 'bg-sage-200'
}

function utilisationTextColor(pct: number): string {
  if (pct >= 60) return 'text-emerald-700'
  if (pct >= 30) return 'text-amber-700'
  return 'text-sage-600'
}

function parseStats(raw: unknown): CapacityStats | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (k: string): number | null => {
    const v = r[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const available = num('available_saturdays')
  const booked = num('booked_count')
  const util = num('utilisation_pct')
  const total = num('total_revenue')
  const yAvail = num('yield_per_available')
  const yBooked = num('yield_per_booked')
  const avg = num('avg_booking_value')
  const year = num('year')
  if (
    available == null ||
    booked == null ||
    util == null ||
    total == null ||
    yAvail == null ||
    yBooked == null ||
    avg == null
  ) {
    return null
  }
  return {
    year: year ?? new Date().getFullYear(),
    available_saturdays: available,
    booked_count: booked,
    utilisation_pct: util,
    total_revenue: total,
    yield_per_available: yAvail,
    yield_per_booked: yBooked,
    avg_booking_value: avg,
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function StatCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-20 bg-sage-100 rounded" />
        <div className="h-8 w-24 bg-sage-100 rounded" />
      </div>
    </div>
  )
}

function VenueCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="h-5 w-40 bg-sage-100 rounded" />
        <div className="h-3 w-full bg-sage-50 rounded" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 bg-sage-50 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function CapacityPage() {
  const scope = useScope()
  const scopedVenueIds = scopeVenueFilter(scope)
  const scopeKey = JSON.stringify(scopedVenueIds)

  const [venues, setVenues] = useState<VenueRow[]>([])
  const [configs, setConfigs] = useState<VenueConfigRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    setLoading(true)
    try {
      let venueQ = supabase
        .from('venues')
        .select('id, name, status')
        .order('name', { ascending: true })
      let configQ = supabase.from('venue_config').select('venue_id, feature_flags')

      const ids: string[] | null = JSON.parse(scopeKey)
      if (ids) {
        venueQ = venueQ.in('id', ids)
        configQ = configQ.in('venue_id', ids)
      }

      const [venueRes, configRes] = await Promise.all([venueQ, configQ])
      if (venueRes.error) throw venueRes.error
      if (configRes.error) throw configRes.error

      setVenues((venueRes.data ?? []) as VenueRow[])
      setConfigs((configRes.data ?? []) as VenueConfigRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch capacity data:', err)
      setError('Failed to load capacity data')
    } finally {
      setLoading(false)
    }
  }, [scopeKey])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Join venues with their capacity stats
  const venueCapacity: VenueCapacity[] = useMemo(() => {
    const cfgByVenue = new Map<string, VenueConfigRow>()
    for (const c of configs) cfgByVenue.set(c.venue_id, c)
    return venues.map((v) => {
      const cfg = cfgByVenue.get(v.id)
      const raw = cfg?.feature_flags
        ? (cfg.feature_flags as Record<string, unknown>)['capacity_2026']
        : null
      return {
        id: v.id,
        name: v.name,
        status: v.status,
        stats: parseStats(raw),
      }
    })
  }, [venues, configs])

  // Portfolio summary — combined across in-scope venues that have stats
  const portfolio = useMemo(() => {
    const withStats = venueCapacity.filter((v) => v.stats != null)
    if (withStats.length === 0) {
      return {
        count: 0,
        available: 0,
        booked: 0,
        utilisation: 0,
        totalRevenue: 0,
        yieldPerAvailable: 0,
        yieldPerBooked: 0,
        avgBooking: 0,
      }
    }
    const available = withStats.reduce((s, v) => s + (v.stats?.available_saturdays ?? 0), 0)
    const booked = withStats.reduce((s, v) => s + (v.stats?.booked_count ?? 0), 0)
    const totalRevenue = withStats.reduce((s, v) => s + (v.stats?.total_revenue ?? 0), 0)
    const utilisation = available > 0 ? (booked / available) * 100 : 0
    const yieldPerAvailable = available > 0 ? totalRevenue / available : 0
    const yieldPerBooked = booked > 0 ? totalRevenue / booked : 0
    const avgBooking = booked > 0 ? totalRevenue / booked : 0
    return {
      count: withStats.length,
      available,
      booked,
      utilisation,
      totalRevenue,
      yieldPerAvailable,
      yieldPerBooked,
      avgBooking,
    }
  }, [venueCapacity])

  const year = 2026

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Capacity & Yield
          </h1>
          <p className="text-sage-600 max-w-2xl">
            How full your Saturday calendar is across {year} and how much revenue you&rsquo;re
            extracting per available date. Use this to price off-peak dates, spot underperforming
            venues, and defend premium rates on booked weekends.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-sage-500 bg-sage-50 border border-border rounded-lg px-3 py-2">
          <CalendarRange className="w-4 h-4 text-sage-400" />
          <span>Reporting year: <span className="font-semibold text-sage-700">{year}</span></span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Portfolio summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="w-4 h-4 text-teal-500" />
                <span className="text-sm font-medium text-sage-600">Portfolio Utilisation</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{fmtPct(portfolio.utilisation)}</p>
              <p className="text-xs text-sage-500 mt-1">
                {portfolio.booked} of {portfolio.available} available Saturdays
              </p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <CalendarRange className="w-4 h-4 text-gold-500" />
                <span className="text-sm font-medium text-sage-600">Yield / Available Date</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{fmt$(portfolio.yieldPerAvailable)}</p>
              <p className="text-xs text-sage-500 mt-1">Total revenue ÷ available dates</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-medium text-sage-600">Yield / Booked Date</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{fmt$(portfolio.yieldPerBooked)}</p>
              <p className="text-xs text-sage-500 mt-1">Total revenue ÷ booked dates</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-sage-500" />
                <span className="text-sm font-medium text-sage-600">Avg Booking Value</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{fmt$(portfolio.avgBooking)}</p>
              <p className="text-xs text-sage-500 mt-1">{fmt$(portfolio.totalRevenue)} total revenue</p>
            </div>
          </>
        )}
      </div>

      {/* Per-venue cards */}
      <div>
        <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">
          Per-venue breakdown
        </h2>
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <VenueCardSkeleton key={i} />
            ))}
          </div>
        ) : venueCapacity.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-8 text-center">
            <Building2 className="w-8 h-8 text-sage-300 mx-auto mb-2" />
            <p className="text-sm text-sage-500">No venues in scope.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {venueCapacity.map((v) => {
              const s = v.stats
              const util = s?.utilisation_pct ?? 0
              return (
                <div
                  key={v.id}
                  className="bg-surface border border-border rounded-xl p-6 shadow-sm"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="font-heading text-lg font-semibold text-sage-900">
                        {v.name}
                      </h3>
                      <p className="text-xs text-sage-500 mt-0.5">
                        {s
                          ? `${s.booked_count} of ${s.available_saturdays} Saturdays booked`
                          : 'No capacity data for this year'}
                      </p>
                    </div>
                    <div className={`text-right ${utilisationTextColor(util)}`}>
                      <p className="text-2xl font-bold tabular-nums">{fmtPct(s?.utilisation_pct)}</p>
                      <p className="text-[10px] uppercase tracking-wide text-sage-400">
                        Utilisation
                      </p>
                    </div>
                  </div>

                  {/* Utilisation bar */}
                  <div className="mb-5">
                    <div className="h-2 bg-sage-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${utilisationColor(util)}`}
                        style={{ width: `${Math.min(util, 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-sage-50 rounded-lg p-3">
                      <p className="text-[10px] uppercase tracking-wide text-sage-500 mb-1">
                        Yield / Available
                      </p>
                      <p className="text-sm font-bold text-sage-900 tabular-nums">
                        {fmt$(s?.yield_per_available)}
                      </p>
                    </div>
                    <div className="bg-sage-50 rounded-lg p-3">
                      <p className="text-[10px] uppercase tracking-wide text-sage-500 mb-1">
                        Yield / Booked
                      </p>
                      <p className="text-sm font-bold text-sage-900 tabular-nums">
                        {fmt$(s?.yield_per_booked)}
                      </p>
                    </div>
                    <div className="bg-sage-50 rounded-lg p-3">
                      <p className="text-[10px] uppercase tracking-wide text-sage-500 mb-1">
                        Avg Booking
                      </p>
                      <p className="text-sm font-bold text-sage-900 tabular-nums">
                        {fmt$(s?.avg_booking_value)}
                      </p>
                    </div>
                  </div>

                  {/* Total revenue footer */}
                  <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
                    <span className="text-xs text-sage-500">Total revenue</span>
                    <span className="text-sm font-bold text-sage-900 tabular-nums">
                      {fmt$(s?.total_revenue)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
