'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createBrowserClient } from '@supabase/ssr'
import {
  BarChart3,
  DollarSign,
  TrendingUp,
  ArrowUpDown,
  Megaphone,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceAttribution {
  id: string
  venue_id: string
  source_name: string
  inquiries: number
  tours: number
  bookings: number
  revenue: number
  calculated_at: string
}

interface MarketingSpend {
  id: string
  venue_id: string
  source_name: string
  month: string
  spend: number
  calculated_at: string
}

interface SourceRow {
  source_name: string
  spend: number
  inquiries: number
  tours: number
  bookings: number
  revenue: number
  cost_per_inquiry: number
  cost_per_booking: number
  conversion_rate: number
  roi: number
}

type SortKey = keyof SourceRow
type SortDir = 'asc' | 'desc'

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

function fmt$(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return `$${Math.round(value).toLocaleString()}`
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

const SOURCE_COLORS: Record<string, string> = {
  'The Knot':     '#E8927C',
  'WeddingWire':  '#7EAAA0',
  'Google':       '#A6894A',
  'Instagram':    '#C084A0',
  'Referral':     '#7D8471',
  'Direct':       '#5D7A7A',
  'Facebook':     '#6A89B7',
  'Zola':         '#9B8EC4',
}

function getSourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? '#7D8471'
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="h-5 w-40 bg-sage-100 rounded" />
        <div className="h-64 bg-sage-50 rounded-lg" />
      </div>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-5 w-48 bg-sage-100 rounded" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 bg-sage-50 rounded" />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SourceAttributionPage() {
  const VENUE_ID = useVenueId()
  const [attributions, setAttributions] = useState<SourceAttribution[]>([])
  const [spendData, setSpendData] = useState<MarketingSpend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('revenue')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // ---- Fetch data ----
  const fetchData = useCallback(async () => {
    const supabase = getSupabase()

    try {
      const [attrRes, spendRes] = await Promise.all([
        supabase
          .from('source_attribution')
          .select('*')
          .eq('venue_id', VENUE_ID)
          .order('calculated_at', { ascending: false }),
        supabase
          .from('marketing_spend')
          .select('*')
          .eq('venue_id', VENUE_ID)
          .order('month', { ascending: true }),
      ])

      if (attrRes.error) throw attrRes.error
      if (spendRes.error) throw spendRes.error

      setAttributions((attrRes.data ?? []) as SourceAttribution[])
      setSpendData((spendRes.data ?? []) as MarketingSpend[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch source attribution data:', err)
      setError('Failed to load source attribution data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Build aggregated source rows ----
  const sourceRows: SourceRow[] = (() => {
    const sourceMap = new Map<string, { attr: SourceAttribution[]; spend: number }>()

    for (const a of attributions) {
      const key = a.source_name || 'Unknown'
      const existing = sourceMap.get(key) ?? { attr: [], spend: 0 }
      existing.attr.push(a)
      sourceMap.set(key, existing)
    }

    for (const s of spendData) {
      const key = s.source_name || 'Unknown'
      const existing = sourceMap.get(key) ?? { attr: [], spend: 0 }
      existing.spend += s.spend
      sourceMap.set(s.source_name, existing)
    }

    const rows: SourceRow[] = []

    for (const [source_name, data] of sourceMap) {
      const inquiries = data.attr.reduce((sum, a) => sum + a.inquiries, 0)
      const tours = data.attr.reduce((sum, a) => sum + a.tours, 0)
      const bookings = data.attr.reduce((sum, a) => sum + a.bookings, 0)
      const revenue = data.attr.reduce((sum, a) => sum + a.revenue, 0)
      const spend = data.spend

      rows.push({
        source_name,
        spend,
        inquiries,
        tours,
        bookings,
        revenue,
        cost_per_inquiry: inquiries > 0 ? spend / inquiries : 0,
        cost_per_booking: bookings > 0 ? spend / bookings : 0,
        conversion_rate: inquiries > 0 ? bookings / inquiries : 0,
        roi: spend > 0 ? (revenue - spend) / spend : 0,
      })
    }

    return rows
  })()

  // ---- Sort ----
  const sortedRows = [...sourceRows].sort((a, b) => {
    const aVal = a[sortKey]
    const bVal = b[sortKey]
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    }
    const aNum = typeof aVal === 'number' ? aVal : 0
    const bNum = typeof bVal === 'number' ? bVal : 0
    return sortDir === 'asc' ? aNum - bNum : bNum - aNum
  })

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // ---- Cost per booking chart data ----
  const costPerBookingData = sortedRows
    .filter((r) => r.bookings > 0)
    .sort((a, b) => a.cost_per_booking - b.cost_per_booking)
    .map((r) => ({
      source: r.source_name,
      costPerBooking: Math.round(r.cost_per_booking),
      fill: getSourceColor(r.source_name),
    }))

  // ---- Spend over time chart data ----
  const spendOverTimeData = (() => {
    const monthMap = new Map<string, Record<string, number>>()
    const allSources = new Set<string>()

    for (const s of spendData) {
      allSources.add(s.source_name)
      const existing = monthMap.get(s.month) ?? {}
      existing[s.source_name] = (existing[s.source_name] ?? 0) + s.spend
      monthMap.set(s.month, existing)
    }

    const months = Array.from(monthMap.keys()).sort()
    return months.map((month) => {
      const row: Record<string, unknown> = {
        month: new Date(month + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      }
      for (const source of allSources) {
        row[source] = monthMap.get(month)?.[source] ?? 0
      }
      return row
    })
  })()

  const allSpendSources = Array.from(new Set(spendData.map((s) => s.source_name)))

  // ---- Summary stats ----
  const totalSpend = sourceRows.reduce((sum, r) => sum + r.spend, 0)
  const totalRevenue = sourceRows.reduce((sum, r) => sum + r.revenue, 0)
  const totalBookings = sourceRows.reduce((sum, r) => sum + r.bookings, 0)
  const overallCPB = totalBookings > 0 ? totalSpend / totalBookings : 0

  // ---- Compute insights from source data ----
  const sourceInsights: InsightItem[] = (() => {
    if (sourceRows.length === 0) return []
    const items: InsightItem[] = []

    // Best performing source (by revenue per inquiry)
    const withInquiries = sourceRows.filter((r) => r.inquiries > 0)
    if (withInquiries.length > 0) {
      const best = [...withInquiries].sort((a, b) => {
        const aRev = a.inquiries > 0 ? a.revenue / a.inquiries : 0
        const bRev = b.inquiries > 0 ? b.revenue / b.inquiries : 0
        return bRev - aRev
      })[0]
      const revPerLead = best.inquiries > 0 ? Math.round(best.revenue / best.inquiries) : 0
      items.push({
        icon: 'trend_up',
        text: `${best.source_name} is your best channel at $${revPerLead.toLocaleString()}/lead in revenue`,
        priority: 'high',
      })
    }

    // Worst ROI source (among those with spend)
    const withSpend = sourceRows.filter((r) => r.spend > 0)
    if (withSpend.length > 1) {
      const worst = [...withSpend].sort((a, b) => a.roi - b.roi)[0]
      items.push({
        icon: 'trend_down',
        text: `${worst.source_name} has the lowest ROI at ${worst.roi >= 0 ? '+' : ''}${(worst.roi * 100).toFixed(0)}% — consider reallocating spend`,
        priority: 'medium',
      })
    }

    // Sources with inquiries but zero bookings
    const zeroBookings = sourceRows.filter((r) => r.inquiries > 0 && r.bookings === 0)
    for (const src of zeroBookings) {
      items.push({
        icon: 'warning',
        text: `${src.source_name} generated ${src.inquiries} inquiries but no bookings — investigate conversion blockers`,
        priority: 'medium',
      })
    }

    return items
  })()

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Source Attribution
        </h1>
        <p className="text-sage-600">
          Compare lead sources head-to-head — which channels bring the most inquiries, the highest quality leads, and the best conversion rates. Allocate your marketing budget based on real data.
        </p>
      </div>

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Megaphone className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Summary Stats ---- */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <div className="animate-pulse space-y-3">
                <div className="h-4 w-24 bg-sage-100 rounded" />
                <div className="h-8 w-16 bg-sage-100 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-red-50 rounded-lg">
                <DollarSign className="w-4 h-4 text-red-500" />
              </div>
              <span className="text-sm font-medium text-sage-600">Total Spend</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{fmt$(totalSpend)}</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-emerald-50 rounded-lg">
                <TrendingUp className="w-4 h-4 text-emerald-600" />
              </div>
              <span className="text-sm font-medium text-sage-600">Total Revenue</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{fmt$(totalRevenue)}</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-teal-50 rounded-lg">
                <BarChart3 className="w-4 h-4 text-teal-600" />
              </div>
              <span className="text-sm font-medium text-sage-600">Total Bookings</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{totalBookings}</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-gold-50 rounded-lg">
                <DollarSign className="w-4 h-4 text-gold-600" />
              </div>
              <span className="text-sm font-medium text-sage-600">Avg Cost / Booking</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{fmt$(overallCPB)}</p>
          </div>
        </div>
      )}

      {/* ---- AI Insights ---- */}
      {!loading && sourceInsights.length > 0 && (
        <InsightPanel insights={sourceInsights} />
      )}

      {/* ---- Cost per Booking Chart ---- */}
      {loading ? (
        <ChartSkeleton />
      ) : costPerBookingData.length > 0 ? (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-4 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-sage-600" />
            Cost per Booking by Source
          </h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={costPerBookingData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                <XAxis
                  dataKey="source"
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    border: '1px solid #E8E4DF',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                  formatter={(value) => [`$${Number(value).toLocaleString()}`, 'Cost per Booking']}
                />
                <Bar
                  dataKey="costPerBooking"
                  radius={[6, 6, 0, 0]}
                  fill="#7D8471"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}

      {/* ---- Source Comparison Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : sortedRows.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Megaphone className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No source attribution data yet
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Source attribution data will appear here once inquiries and marketing spend are tracked.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
              <ArrowUpDown className="w-5 h-5 text-sage-600" />
              Source Comparison
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-sage-50/50">
                  {([
                    ['source_name', 'Source'],
                    ['spend', 'Spend'],
                    ['inquiries', 'Inquiries'],
                    ['tours', 'Tours'],
                    ['bookings', 'Bookings'],
                    ['revenue', 'Revenue'],
                    ['cost_per_inquiry', 'Cost / Inquiry'],
                    ['cost_per_booking', 'Cost / Booking'],
                    ['conversion_rate', 'Conv. Rate'],
                    ['roi', 'ROI'],
                  ] as [SortKey, string][]).map(([key, label]) => (
                    <th
                      key={key}
                      className="px-4 py-3 text-left font-medium text-sage-600 cursor-pointer hover:text-sage-900 transition-colors select-none whitespace-nowrap"
                      onClick={() => handleSort(key)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {sortKey === key && (
                          <ArrowUpDown className="w-3 h-3 text-sage-400" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedRows.map((row) => (
                  <tr key={row.source_name} className="hover:bg-sage-50/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-sage-900 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: getSourceColor(row.source_name) }}
                        />
                        {row.source_name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmt$(row.spend)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{row.inquiries}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{row.tours}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{row.bookings}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums font-medium">{fmt$(row.revenue)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmt$(row.cost_per_inquiry)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmt$(row.cost_per_booking)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtPct(row.conversion_rate)}</td>
                    <td className="px-4 py-3 tabular-nums">
                      <span className={`font-semibold ${row.roi >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {row.roi > 0 ? '+' : ''}{fmtPct(row.roi)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Spend Over Time Chart ---- */}
      {loading ? (
        <ChartSkeleton />
      ) : spendOverTimeData.length > 0 ? (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-sage-600" />
            Monthly Spend by Source
          </h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={spendOverTimeData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    border: '1px solid #E8E4DF',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                  formatter={(value, name) => [`$${Number(value).toLocaleString()}`, name]}
                />
                <Legend
                  wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
                />
                {allSpendSources.map((source) => (
                  <Line
                    key={source}
                    type="monotone"
                    dataKey={source}
                    stroke={getSourceColor(source)}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}
    </div>
  )
}
