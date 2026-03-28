'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  MapPin,
  Building2,
  TrendingUp,
  DollarSign,
  CalendarCheck,
  ChevronRight,
  X,
} from 'lucide-react'
import {
  BarChart,
  Bar,
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
  created_at: string
}

interface RegionData {
  state: string
  venueCount: number
  inquiries: number
  bookings: number
  revenue: number
  venues: { id: string; name: string; inquiries: number; bookings: number; revenue: number }[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function RegionCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-5 w-28 bg-sage-100 rounded" />
        <div className="h-4 w-20 bg-sage-50 rounded" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-10 bg-sage-50 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function RegionalAnalyticsPage() {
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const [venueRes, weddingRes] = await Promise.all([
        supabase.from('venues').select('id, name, state'),
        supabase.from('weddings').select('id, venue_id, status, booking_value, created_at'),
      ])
      if (venueRes.error) throw venueRes.error
      if (weddingRes.error) throw weddingRes.error
      setVenues((venueRes.data ?? []) as VenueRow[])
      setWeddings((weddingRes.data ?? []) as WeddingRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch regional data:', err)
      setError('Failed to load regional data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Group by state
  const regions: RegionData[] = useMemo(() => {
    const stateMap = new Map<string, VenueRow[]>()
    for (const v of venues) {
      const state = v.state || 'Unknown'
      const list = stateMap.get(state) ?? []
      list.push(v)
      stateMap.set(state, list)
    }

    return Array.from(stateMap.entries())
      .map(([state, stateVenues]) => {
        const venueIds = new Set(stateVenues.map((v) => v.id))
        const regionWeddings = weddings.filter((w) => venueIds.has(w.venue_id))
        const booked = regionWeddings.filter((w) =>
          ['contracted', 'completed'].includes(w.status)
        )

        const venueDetails = stateVenues.map((v) => {
          const vw = weddings.filter((w) => w.venue_id === v.id)
          const vb = vw.filter((w) => ['contracted', 'completed'].includes(w.status))
          return {
            id: v.id,
            name: v.name,
            inquiries: vw.length,
            bookings: vb.length,
            revenue: vb.reduce((s, w) => s + (w.booking_value ?? 0), 0),
          }
        })

        return {
          state,
          venueCount: stateVenues.length,
          inquiries: regionWeddings.length,
          bookings: booked.length,
          revenue: booked.reduce((s, w) => s + (w.booking_value ?? 0), 0),
          venues: venueDetails,
        }
      })
      .sort((a, b) => b.revenue - a.revenue)
  }, [venues, weddings])

  // Chart data
  const chartData = useMemo(
    () =>
      regions.map((r) => ({
        name: r.state.length > 12 ? r.state.slice(0, 12) + '...' : r.state,
        inquiries: r.inquiries,
        bookings: r.bookings,
        revenue: r.revenue,
      })),
    [regions]
  )

  const drillRegion = regions.find((r) => r.state === selectedRegion)

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Regional Analytics
        </h1>
        <p className="text-sage-600">
          Performance grouped by state/region across all venues.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <MapPin className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Region Cards */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <RegionCardSkeleton key={i} />
          ))}
        </div>
      ) : regions.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <MapPin className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No regional data
          </h3>
          <p className="text-sm text-sage-600">Add venue states to enable regional grouping.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {regions.map((r) => (
              <button
                key={r.state}
                onClick={() => setSelectedRegion(r.state)}
                className="bg-surface border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-all text-left group"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-sage-500" />
                    <h3 className="font-heading text-base font-semibold text-sage-900">
                      {r.state}
                    </h3>
                  </div>
                  <ChevronRight className="w-4 h-4 text-sage-400 group-hover:text-sage-600 transition-colors" />
                </div>
                <p className="text-xs text-sage-500 mb-4">
                  {r.venueCount} venue{r.venueCount !== 1 ? 's' : ''}
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
                    <TrendingUp className="w-3 h-3 text-teal-500 mb-1" />
                    <p className="text-xs text-sage-500">Inquiries</p>
                    <p className="text-base font-bold text-sage-900 tabular-nums">{r.inquiries}</p>
                  </div>
                  <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
                    <CalendarCheck className="w-3 h-3 text-gold-500 mb-1" />
                    <p className="text-xs text-sage-500">Bookings</p>
                    <p className="text-base font-bold text-sage-900 tabular-nums">{r.bookings}</p>
                  </div>
                  <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
                    <DollarSign className="w-3 h-3 text-sage-500 mb-1" />
                    <p className="text-xs text-sage-500">Revenue</p>
                    <p className="text-base font-bold text-sage-900 tabular-nums">{fmt$(r.revenue)}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Comparison chart */}
          {chartData.length > 1 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">
                Regional Comparison
              </h2>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#FFF', border: '1px solid #E8E4DF', borderRadius: '8px', fontSize: '13px' }} />
                    <Bar dataKey="inquiries" name="Inquiries" fill="#7D8471" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="bookings" name="Bookings" fill="#A6894A" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Drill-down drawer */}
          {drillRegion && (
            <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h2 className="font-heading text-lg font-semibold text-sage-900 flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-sage-600" />
                  {drillRegion.state} &mdash; Venues
                </h2>
                <button
                  onClick={() => setSelectedRegion(null)}
                  className="p-1.5 rounded-lg hover:bg-sage-50 transition-colors"
                >
                  <X className="w-4 h-4 text-sage-500" />
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-warm-white">
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Venue</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Inquiries</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Bookings</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {drillRegion.venues.map((v) => (
                      <tr key={v.id} className="hover:bg-sage-50/50 transition-colors">
                        <td className="px-6 py-4 font-medium text-sage-900 flex items-center gap-2">
                          <Building2 className="w-4 h-4 text-sage-400" />
                          {v.name}
                        </td>
                        <td className="px-6 py-4 text-sage-700 tabular-nums">{v.inquiries}</td>
                        <td className="px-6 py-4 text-sage-700 tabular-nums">{v.bookings}</td>
                        <td className="px-6 py-4 text-sage-700 tabular-nums">{fmt$(v.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
